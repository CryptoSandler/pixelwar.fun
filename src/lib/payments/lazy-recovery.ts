import { execute } from "../db";
import { expireStaleOrders, type Order } from "./orders";
import { recoverOrder, type RecoveryFetcher } from "./recover";

/**
 * Reconciliation that rides on the request that cares about it.
 *
 * WHY THIS EXISTS. Recovery used to depend entirely on an external scheduler
 * arriving on time, and the measurement is what killed that: GitHub Actions
 * delivered `reconcile.yml` 2h29m apart on a schedule asking for every five minutes, and ~1h32m apart
 * on average in a second repository. `LATE_CONFIRM_GRACE_MINUTES` is 10. A
 * pass that lands two hours late cannot reclaim the colour a payer paid for —
 * it can only file the payment for a human, which converts a self-healing
 * case into a support ticket. Vercel Cron is not the replacement either: on
 * Hobby it runs once per day and fires anywhere inside the nominated hour.
 *
 * So the trigger moves to the one event that is guaranteed to be on time,
 * because it IS the thing being waited for: the payer's own request about
 * their own order. There is no scheduler between the payment and the pass
 * any more, and therefore no scheduler that can be late.
 *
 * WHAT IT DOES NOT REPLACE. The payer who signs and never comes back still
 * needs a sweep, and that is what the daily Vercel cron in `vercel.json` and
 * the hourly `reconcile.yml` backstop are for. Those are a floor on how long
 * money can sit unfiled — they were never able to be a ceiling on how fast a
 * watching payer is served, and this is what serves that payer.
 */

/**
 * How long one order must wait between lazy passes.
 *
 * The client polls `GET /api/orders/[id]` every two seconds
 * (`STATUS_POLL_MS` in `PayWithWallet.tsx`). Without a floor, a single open
 * tab would spend one `getSignaturesForAddress` plus up to
 * `MAX_SIGNATURES_PER_REFERENCE` `getTransaction` calls every two seconds,
 * against the same rate-limited endpoint every other payer's checkout is
 * using — the exact cost the original design moved OFF the request path to
 * avoid, reintroduced at thirty times the rate.
 *
 * Sixty seconds, and the first look is not delayed by it: a never-examined
 * order has `recovery_attempted_at IS NULL`, so the very first poll after
 * expiry claims it immediately. The cooldown only bounds the retries after
 * that. Chain state that would change the verdict does not change on a
 * two-second cadence anyway — a transaction that was not visible a second
 * ago is not usually visible now.
 */
const LAZY_RECOVERY_COOLDOWN_SECONDS = 60;

/**
 * Takes this order for a lazy pass, or reports that somebody else has it.
 *
 * This is the answer to "what stops two concurrent requests reconciling the
 * same order twice", and it is deliberately not a new mechanism. It is a
 * compare-and-swap on `recovery_attempted_at` — the column migration 004
 * already added and the pass already stamps — expressed as a single
 * conditional UPDATE. Postgres executes it atomically, so of N requests
 * racing on one order, exactly one gets `rowCount === 1` and the rest get 0.
 *
 * Deliberately NOT an advisory lock: a lock held across the RPC calls below
 * would tie a Postgres session up for as long as the chain takes to answer,
 * and a serverless function that dies mid-pass would hold it until the
 * session was reaped. The stamp needs no release — the cooldown IS the
 * release, and a crashed pass simply retries a minute later instead of
 * wedging the order.
 *
 * It doubles as the rate limiter, which is why there is one mechanism here
 * and not two: "somebody is already doing this" and "this was done a moment
 * ago" are the same question asked of the same column, and the same answer
 * (do nothing) is right for both.
 *
 * Note what is NOT relied on here for correctness. Double-*settlement* is
 * already impossible: `settlePayment` claims the signature with
 * `ON CONFLICT (signature) DO NOTHING` and takes `FOR UPDATE` on the order
 * row (see `settle.ts`). This claim is about not spending the RPC budget
 * twice for one answer — money safety is settled a layer down, and would
 * still hold if this function were deleted.
 */
export async function claimForRecovery(
  orderId: string,
  cooldownSeconds: number = LAZY_RECOVERY_COOLDOWN_SECONDS,
): Promise<boolean> {
  const claimed = await execute(
    `UPDATE entry_orders
        SET recovery_attempted_at = now()
      WHERE id = $1
        AND status = 'expired'
        AND (recovery_attempted_at IS NULL
             OR recovery_attempted_at <= now() - make_interval(secs => $2))`,
    [orderId, cooldownSeconds],
  );
  return claimed === 1;
}

export type LazyRecoveryOutcome = {
  /** Whether this call actually ran a pass, as opposed to declining to. */
  ran: boolean;
  recovered: boolean;
  filed: boolean;
};

const DECLINED: LazyRecoveryOutcome = { ran: false, recovered: false, filed: false };

/**
 * One order's lazy reconciliation, start to finish.
 *
 * MUST NOT be awaited on the request path — every caller runs it inside
 * `after()` so the response has already been sent. See `scheduleReconcile`,
 * which is the only thing any route should call.
 *
 * The three steps are ordered, and the order is the interesting part:
 *
 * 1. EXPIRE, but only when this order needs it. Recovery's precondition is
 *    `status = 'expired'`, and nothing sets that status except
 *    `expireStaleOrders`, whose other call sites are lazy in a way that does
 *    not help here — `freeColours` and `createOrder` run when SOMEBODY ELSE
 *    is browsing, which is precisely not guaranteed for the payer coming
 *    back to a dead tab. Without this line a returning payer's order sits at
 *    `pending` past its own `expires_at` and the claim below refuses it
 *    forever, so the lazy path would be wired up, tested, and unreachable.
 *    Guarded on this order actually being past its window, so an ordinary
 *    poll of a healthy pending order does not run a global UPDATE.
 *
 * 2. CLAIM, which is both the lock and the cooldown. See `claimForRecovery`.
 *
 * 3. RECOVER exactly this order. `recoverOrder` re-reads the row, so it sees
 *    the status step 1 may have just written rather than the stale one the
 *    caller handed in.
 */
export async function reconcileOnRead(
  order: Pick<Order, "id" | "status" | "expiresAt">,
  fetcher: RecoveryFetcher = {},
): Promise<LazyRecoveryOutcome> {
  if (order.status === "pending" && order.expiresAt.getTime() <= Date.now()) {
    await expireStaleOrders();
  } else if (order.status !== "expired") {
    // `paid` and `failed` have nothing to recover, and a `pending` order
    // still inside its window belongs to `/confirm`. Bail before spending a
    // write on the claim.
    return DECLINED;
  }

  if (!(await claimForRecovery(order.id))) return DECLINED;

  const { recovered, filed } = await recoverOrder(order.id, fetcher);
  return { ran: true, recovered, filed };
}

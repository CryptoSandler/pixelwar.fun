import { createHash, timingSafeEqual } from "node:crypto";
import { json, NO_STORE } from "../../../../lib/http";
import { expireStaleOrders } from "../../../../lib/payments/orders";
import { currentAbuseSignal } from "../../../../lib/paint/abuse";
import { unmatchedBacklog } from "../../../../lib/payments/orphans";
import { recoverUnclaimedOrders } from "../../../../lib/payments/recover";

export const dynamic = "force-dynamic";

/**
 * The trigger for recovery.
 *
 * Expiry is lazy — `freeColours` and `createOrder` run it themselves, so no
 * route can forget to (see `orders.ts`). Recovery cannot be: it makes RPC
 * calls, one per candidate signature, against a rate-limited endpoint shared
 * with every live checkout. Hanging that off a payer's request would make
 * somebody else's checkout pay for it, in latency and in quota. So it gets
 * its own trigger, called on a schedule from outside — see
 * `.github/workflows/reconcile.yml`, which is a GitHub Actions workflow
 * rather than Vercel Cron for the reason this route's guard implies: Vercel
 * Cron cannot send a request header.
 *
 * It also expires before it recovers, because recovery's candidate set is
 * something expiry produces and lazy expiry only produces it when the site
 * has visitors. The call site below has the full argument.
 *
 * WHAT THIS IS NOW FOR. It is no longer the primary trigger. Reconciliation
 * for a payer who is present happens on the request path — see
 * `lazy-recovery.ts`, hooked into `GET /api/orders/[id]` and
 * `/join/[orderId]` — because measurement showed no external scheduler could
 * be relied on to arrive inside `LATE_CONFIRM_GRACE_MINUTES`. This endpoint
 * is the SWEEP: the floor under the payer who signed, closed the tab, and
 * never came back, whose order no request will ever name.
 *
 * TWO METHODS, TWO CALLERS, ONE BODY.
 *
 *   POST + `x-cron-secret`  — `.github/workflows/reconcile.yml`, the hourly
 *                             backstop. A header it chooses, on a method that
 *                             says what it does.
 *   GET  + `Authorization`  — Vercel Cron (`crons` in `vercel.json`), the
 *                             daily sweep. Neither half of that is our
 *                             choice: Vercel invokes cron paths with GET, and
 *                             the only credential it sends is the value of
 *                             `CRON_SECRET` as `Authorization: Bearer <...>`,
 *                             provisioned by the platform rather than by us.
 *
 * GET mutating is a real wart and worth naming rather than hiding. What makes
 * it safe here is not the method but the guard: no unauthenticated caller can
 * reach the work, the route is `force-dynamic` and answers `no-store`, and
 * Vercel Cron does not follow redirects or replay from cache. It is still a
 * GET that changes rows, and if Vercel ever sends POST this half should go.
 */

/**
 * Whether the caller presented the shared secret.
 *
 * Both sides are hashed before the comparison, for two reasons.
 * `timingSafeEqual` throws outright on buffers of different lengths, so a
 * raw comparison would need a length check first — and that check is itself
 * an oracle, answering "how long is the secret" one guess at a time. SHA-256
 * digests are always 32 bytes, so the comparison is constant-time across
 * every input, including inputs of the wrong length, and leaks nothing about
 * the expected value.
 */
function presentedSecret(provided: string, expected: string): boolean {
  const a = createHash("sha256").update(provided, "utf8").digest();
  const b = createHash("sha256").update(expected, "utf8").digest();
  return timingSafeEqual(a, b);
}

/**
 * The credential this caller presented, from whichever header carries it.
 *
 * Both are checked on both methods rather than pairing one header to one
 * method: the pairing would be a rule this file invents and nothing else
 * enforces, and its only effect would be to turn a caller that used the
 * "wrong" one into a 401 that looks exactly like a wrong secret. The secret
 * is the credential; which header carried it says nothing about authority.
 *
 * An `Authorization` value that is not `Bearer <something>` yields the empty
 * string, which then fails `presentedSecret` like any other wrong value —
 * there is no separate "malformed" answer, because telling malformed apart
 * from wrong is an oracle and neither one is getting in.
 */
function presentedCredential(request: Request): string {
  const direct = request.headers.get("x-cron-secret");
  if (direct) return direct;

  const authorization = request.headers.get("authorization") ?? "";
  const [scheme, ...rest] = authorization.split(" ");
  if (scheme?.toLowerCase() !== "bearer") return "";
  return rest.join(" ").trim();
}

/**
 * Vercel Cron's daily sweep. See this module's doc comment on why the daily
 * half of reconciliation arrives as a GET and why that is tolerated.
 */
export async function GET(request: Request): Promise<Response> {
  return reconcile(request);
}

/** The hourly backstop from GitHub Actions. */
export async function POST(request: Request): Promise<Response> {
  return reconcile(request);
}

async function reconcile(request: Request): Promise<Response> {
  const expected = process.env.CRON_SECRET?.trim();

  // Fails closed, and deliberately so. An unset secret means this deployment
  // was never configured to run reconciliation, not that reconciliation is
  // open to everybody: the alternative — run unguarded when unconfigured —
  // turns one missing environment variable into a public endpoint that spends
  // the RPC quota of every checkout in flight, on demand, for anyone who
  // finds the path. 503 rather than 401 because the fault is this
  // deployment's, not the caller's.
  if (!expected) {
    console.error("cron/reconcile: CRON_SECRET is not set; refusing every request.");
    return json({ error: "Reconciliation is not configured." }, { status: 503, headers: NO_STORE });
  }

  const provided = presentedCredential(request);
  if (!presentedSecret(provided, expected)) {
    return json({ error: "Unauthorized." }, { status: 401, headers: NO_STORE });
  }

  // Expiry runs here too, and this is NOT a redundant third copy of the call
  // in `freeColours` and `createOrder` — it is the one that makes this route
  // work at all. Read the dependency before deleting it:
  //
  // `recoverUnclaimedOrders` selects on `status = 'expired'`. Nothing in this
  // system sets that status except `expireStaleOrders`, and the other two call
  // sites are LAZY — they run only when somebody loads the colour picker or
  // opens an order. So without this line, the recovery pass's input is
  // produced by site traffic, and a pass that lands when nobody is browsing
  // finds an empty candidate set and returns zero however many payments are
  // actually sitting there unrecovered.
  //
  // That is exactly backwards. Recovery exists for the payer who signed a
  // transfer and closed the tab — the case where nobody is watching. A
  // recovery pass that only works while the site is busy does not cover the
  // case it was built for. One extra query per pass buys this route its own
  // input, so it depends on its schedule and nothing else.
  await expireStaleOrders();

  const { recovered, filed } = await recoverUnclaimedOrders();

  // THE PILE, not just this pass's flow. `filed` counts what THIS run could
  // not settle; a payment filed a week ago is in neither number and has been
  // in neither number every run since. Reporting the backlog here is what
  // lets the scheduled caller shout about it — see reconcile.yml, which
  // fails the job rather than warning, because a warning in a log nobody
  // opens is not an alert.
  const backlog = await unmatchedBacklog();

  // "Something odd is happening on the board", carried on the same request
  // for the same reason the backlog is: this is the one call that already
  // runs on a schedule and already reaches a human when it fails. It reports
  // and does not act — see `abuse.ts` on why nothing here can safely brake.
  const board = await currentAbuseSignal();

  // Counts, not ids. An order id is the handle on somebody's payment, and
  // this response leaves the deployment for a CI log that is retained for
  // ninety days and, on a public repository, is world-readable. The numbers
  // are what a schedule needs to know; the ids are in the database.
  return json(
    {
      recovered: recovered.length,
      filed: filed.length,
      // Counts and an age, never ids — this body reaches a CI log retained
      // for ninety days and world-readable on a public repository, and an
      // order id is the handle on somebody's payment.
      backlog: {
        open: backlog.open,
        oldestAgeHours: backlog.oldestAgeHours,
        stale: backlog.stale,
      },
      // Rate and location only. No ids, no painter keys, no addresses — this
      // body reaches a public CI log, and "who" is a question for /admin.
      board: board
        ? {
            war: board.warSlug,
            windowMinutes: board.windowMinutes,
            paints: board.paints,
            perMinute: board.perMinute,
            hottest: board.hottest,
            worthALook: board.worthALook,
          }
        : null,
    },
    { headers: NO_STORE },
  );
}

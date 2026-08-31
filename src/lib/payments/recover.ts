import { execute, query } from "../db";
import { paymentWallet, RPC_BACKOFF_MAX_MS, RPC_BACKOFF_MS, RPC_COMMITMENT, RPC_MAX_ATTEMPTS, solanaRpcUrls } from "./config";
import { orderById, type Order } from "./orders";
import { settlePayment, type SettleFailureReason } from "./settle";
import { verifySolPayment } from "./sol-transfer";
import type { TransactionFetcher } from "./solana";

/**
 * Recovery: the payoff for the reference key.
 *
 * A Solana Pay reference is a fresh, single-use public key minted for one
 * order and attached to its transfer as a read-only account (see
 * `orders.ts`'s `referencePubkey`) — its secret half is discarded, unread,
 * the instant the order is created, so nothing here or anywhere else in this
 * project can sign with it. What it is good for is `getSignaturesForAddress`:
 * the chain itself can be asked "what transaction ever touched this exact
 * key", which is how a payer who signs a transfer and closes the tab before
 * `/confirm` ever runs still gets found later.
 *
 * That key is a weaker binding than it first looks, though, and the rest of
 * this file is written around that fact rather than around the stronger
 * claim it might seem to license: a reference is an *address*, and any
 * transaction can name any address, including one built by someone who is
 * not the payer at all — the reference is public the moment the payer's own
 * transfer lands (it's a read-only account in that transaction, and it's
 * returned to the browser when the order is created). `getSignaturesForAddress`
 * answers "what mentioned this key", not "what the payer sent". So every
 * signature this pass finds is a *candidate*, never a fact — `verifyPayment`
 * and `settlePayment` are what actually decide whether a candidate is worth
 * anything, exactly as they do for a signature a payer submits by hand, and
 * a candidate that turns out to be junk (a stranger's dust transfer naming
 * this reference, say) must never be allowed to stop the search for the real
 * one, or to crowd it out of the search entirely. See the loop below and
 * `collectOldestCandidates` for how both are kept true.
 *
 * Every order this function can help has already expired unpaid — a fresh
 * `pending` order still has a payer's own browser polling `/confirm` for it,
 * and there is nothing to "recover" yet. Settlement itself is entirely
 * `settlePayment`'s: this function's only job is finding the signature and
 * handing it over. Two ways to mark an order paid is two places for them to
 * disagree, and settlement is where a mistake costs somebody real money.
 */

/** One entry from `getSignaturesForAddress`, reduced to what this file needs. */
export type SignatureCandidate = {
  signature: string;
  /**
   * Unix seconds, as the chain reports it. `null` when the chain does not
   * report one for this entry — treated conservatively throughout this file
   * (never assumed to be old enough to stop paging on, never assumed to
   * predate an order's `createdAt`).
   */
  blockTime: number | null;
};

/**
 * Fetches one page of the signatures whose transaction named `reference`,
 * newest first, strictly older than `before` when it is supplied (omitted
 * for the newest page). Mirrors `getSignaturesForAddress`'s own paging
 * contract so the default implementation is a thin wrapper over the real
 * RPC call.
 */
export type SignaturesPageFetcher = (
  reference: string,
  before?: string,
) => Promise<SignatureCandidate[]>;

export type RecoveryFetcher = {
  /**
   * Untrusted — see the module doc comment. Defaults to a real, paged RPC
   * call. `collectOldestCandidates` is what turns however many pages this
   * returns into the bounded, oldest-first candidate list the loop below
   * actually verifies.
   */
  signatures?: SignaturesPageFetcher;
  /**
   * Forwarded to `verifyPayment` unchanged. Omit it and `verifyPayment`
   * reaches the real RPC itself, exactly as it does for `/confirm`.
   */
  transaction?: TransactionFetcher;
};

/**
 * How many expired-and-unpaid orders one pass looks at.
 *
 * This runs against the public mainnet RPC endpoint (unless a paid provider
 * is configured — see `solanaRpcUrls`), whose rate limit is shared with
 * every payer's live checkout: `verifyPayment` alone spends a real
 * `getTransaction` request per signature it looks at, on top of the
 * `getSignaturesForAddress` calls `collectOldestCandidates` makes per order.
 * A recovery pass that exhausts the quota to rescue old payments would break
 * the checkout it exists to protect. Called "lazily today" and, later, on a
 * schedule (Batch E's reconcile cron); either caller can simply run this
 * again a moment later to keep working through a longer backlog — which is
 * only true because `recovery_attempted_at` (see `unclaimedOrders` below)
 * makes each pass advance to different candidates instead of re-reading the
 * same twenty rows forever.
 */
const MAX_ORDERS_PER_PASS = 20;

/**
 * How many signatures we request per `getSignaturesForAddress` call.
 * Deliberately wide: the ordinary order (one real transfer, maybe one retry)
 * is fully covered by a single page at this size, so `collectOldestCandidates`
 * makes exactly one RPC call for it — the same cost as before this file paged
 * at all.
 */
const SIGNATURE_PAGE_SIZE = 25;

/**
 * How many pages `collectOldestCandidates` will fetch, backward, per order,
 * looking for a transaction at or before that order's own `createdAt` (see
 * that function for why finding one means the search is complete).
 * `SIGNATURE_PAGE_SIZE * SIGNATURE_PAGE_CEILING` = 100 transactions examined
 * for paging purposes, which is generous room for a determined but not
 * extraordinary flood of dust naming one reference, while keeping the worst
 * case — this many RPC round trips, per order, on top of the unchanged
 * `getTransaction` spend below — small enough that `MAX_ORDERS_PER_PASS`
 * orders in one pass cannot turn into an unbounded request storm. Past this
 * many pages without ever finding the boundary is treated as an operator
 * problem, not something to keep retrying silently — see the `console.error`
 * in `collectOldestCandidates`.
 */
const SIGNATURE_PAGE_CEILING = 4;

/**
 * How many candidates `verifyPayment` — and the real `getTransaction` request
 * each call spends — is run against, per order, per pass. Independent of how
 * many pages `collectOldestCandidates` had to fetch to assemble that list:
 * `SIGNATURE_PAGE_CEILING` widens the (cheaper, batchable) *fetch*, this caps
 * the (expensive) *verification spend*, and the two are deliberately not the
 * same knob. A reference should have at most one real transfer; a handful of
 * extra slots covers a payer who retried (e.g. topping up an underpayment) in
 * a second transaction against the same reference.
 */
const MAX_SIGNATURES_PER_REFERENCE = 5;

/**
 * How long after its own expiry an order can still have a payment applied to
 * it AUTOMATICALLY — and nothing else.
 *
 * A real payment that is ever going to show up on the chain does so within
 * minutes to hours of the order expiring — Solana confirms in seconds, and
 * even a payer whose wallet held a signed transfer unbroadcast for a while
 * has no plausible reason to broadcast it a week later. Seven days is
 * generous slack past that for a slow retry, and past it this pass stops
 * trying to give an order's colour away on chain evidence alone.
 *
 * This used to be the candidate query's own WHERE clause, which made it two
 * bounds wearing one name: past it a payment was never recovered *and never
 * filed to `unmatched_payments`* — real money in our wallet, invisible to
 * the only people who could return it, with nothing anywhere marking the
 * moment it stopped being looked for. The two are now separate, because they
 * were never the same question. Age bounds the COLOUR; nothing bounds the
 * RECORD.
 *
 * Past the bound, the pass verifies the candidate against the order's OWN
 * payment window instead of the widened one (see `recoverUnclaimedOrders`),
 * so the verdict can only be `outside_bid_window` — filed when the money
 * genuinely reached our wallet, and never settled. A transfer that did land
 * inside that window reaches `settlePayment`, which is past
 * `LATE_CONFIRM_GRACE_MINUTES` by more than seven days and so can only file
 * `late_confirm_past_grace` too. Both paths file; neither can take a seat.
 *
 * What it costs, stated plainly rather than only in its own favour: an
 * expired order is now a candidate forever, so a deployment with a long tail
 * of abandoned reservations keeps spending one `getSignaturesForAddress` per
 * candidate per pass on orders that will never resolve, where before they
 * aged out. The per-pass ceiling is unchanged (`MAX_ORDERS_PER_PASS` bounds
 * it, and `recovery_attempted_at ASC NULLS FIRST` still gives every
 * freshly-expired order first look), but an idle deployment no longer makes
 * an idle pass. ponytail: if that spend ever matters, the fix is a second,
 * much wider horizon past which an order stops being looked at at all —
 * measured in months, and chosen as a cost decision rather than smuggled
 * back in under this one.
 */
const RECOVERY_MAX_AGE_DAYS = 7;

const RECOVERY_MAX_AGE_MS = RECOVERY_MAX_AGE_DAYS * 24 * 60 * 60 * 1000;

/**
 * `settlePayment` failure reasons that CAN mean a real payment was written
 * to `unmatched_payments` — see `fileUnmatched`'s call sites in settle.ts.
 * Not every failure reason gets here: `signature_reused`, the "never
 * spendable anywhere" verdicts (`failed_tx`/`wrong_token`/a substantiated
 * `wrong_destination`) and the retryable ones (`not_confirmed`/
 * `rpc_unavailable`/`no_block_time`/`invalid_signature`) all leave nothing
 * behind, by design — see `handleVerificationFailure`'s own doc comment in
 * settle.ts.
 *
 * "Can", not "does", for the three verification verdicts: `wrong_payer`,
 * `insufficient_amount` and `outside_bid_window` file only when the
 * transaction genuinely credited our wallet, which is the only case there is
 * anything to file. Over-reporting an order here costs a name on a list an
 * operator reads; under-reporting one loses the lead entirely, so this set
 * is deliberately the wider of the two.
 *
 * Critically, all three also leave the signature itself unclaimed
 * (`settle.ts`'s `handleVerificationFailure` never reaches
 * `consumed_signatures` for any of them) — a junk candidate that lands on
 * one of these verdicts today will land on the exact same verdict again
 * tomorrow. A reason being in this set means "record it", never "stop
 * looking" — see the loop below.
 */
const FILED_REASONS = new Set<SettleFailureReason>([
  "unmatched",
  "wrong_payer",
  "insufficient_amount",
  "outside_bid_window",
  "already_settled",
]);

/**
 * Runs one recovery pass.
 *
 * For each expired, still-unpaid order (capped at `MAX_ORDERS_PER_PASS`,
 * least-recently-examined first — see `unclaimedOrders`), assembles that
 * order's oldest-first candidate signatures (`collectOldestCandidates`) and
 * tries every one, in that order, until one settles the order.
 *
 * A filed verdict (`FILED_REASONS`) does not stop the search: it means
 * *this candidate* is not this order's payment — a stray transfer that
 * merely named the reference, or a genuine underpayment — not that the
 * order has nothing to find. `wrong_payer`, `insufficient_amount` and
 * `outside_bid_window` specifically leave the signature unclaimed (see
 * `FILED_REASONS`'s own comment), so treating them as a reason to stop would make one cheap junk
 * transaction — sent by anyone, since the reference is public the instant a
 * real payment lands — a *permanent* block on that order ever being
 * recovered or even filed, forever, on every future pass. Only
 * `result.ok` ends the search for an order; every filed verdict along the
 * way is still recorded (an order can appear in both `recovered` and
 * `filed` in the same pass, if a junk candidate was filed before the real
 * payment was found), and a candidate this order's own transaction cannot
 * possibly be spent by (`signature_reused`) or that could never have paid
 * anything are silently skipped in favour of the next one.
 *
 * `verifyPayment`'s window is widened forward only: `expiresAtMs` is
 * `Date.now()` rather than the order's own `expiresAt`, so a late transfer —
 * found by reference rather than submitted by a payer — is not rejected as
 * `outside_bid_window` before `settlePayment` ever gets a chance to record
 * it (see the `FILED_REASONS` path this makes reachable). `createdAtMs`
 * stays the order's real `createdAt`: a payment cannot predate the order
 * whose reference it names, so widening backward would only ever admit more
 * candidates a hostile sender could throw at this loop, never a real one.
 *
 * That widening is exactly what `RECOVERY_MAX_AGE_DAYS` withdraws. An order
 * more than that old is still examined, still verified and still filed — it
 * simply gets the order's own `expiresAt` back as the window, which is the
 * whole of what the age bound now does. Every candidate for such an order
 * therefore ends in `outside_bid_window` (filed when the money reached our
 * wallet, with the chain's own sender on the row, and the signature left
 * unclaimed so the payer can still spend it) or, if it did land inside that
 * window, in `settlePayment`'s own past-grace filing. Nothing on either path
 * can seat a token.
 *
 * Every order is examined and stamped exactly once per pass, whatever
 * happens while examining it — `collectOldestCandidates` or `settlePayment`
 * throwing included. Without that, an order with a persistently failing
 * signature fetch would keep `recovery_attempted_at IS NULL` forever, sort
 * ahead of every other candidate on every future pass (`NULLS FIRST` —
 * see `unclaimedOrders`), and the pass would walk into it and die each time,
 * starving every order behind it — the exact failure mode the marker exists
 * to prevent, reintroduced through the error path instead of the selection
 * query.
 */
export async function recoverUnclaimedOrders(
  fetcher: RecoveryFetcher = {},
): Promise<{ recovered: string[]; filed: string[] }> {
  const recovered: string[] = [];
  const filed: string[] = [];

  const wallet = paymentWallet();
  if (!wallet.ok) {
    console.error(`recoverUnclaimedOrders: ${wallet.reason}`);
    return { recovered, filed };
  }

  const orders = await unclaimedOrders(MAX_ORDERS_PER_PASS);

  for (const order of orders) {
    const outcome = await examineOrder(order, wallet.address, fetcher);
    if (outcome.recovered) recovered.push(order.id);
    if (outcome.filed) filed.push(order.id);
  }

  return { recovered, filed };
}

/**
 * One order, examined once. The body of the pass above, and the whole of what
 * the lazy single-order path runs — see `recoverOrder`.
 *
 * Extracted rather than duplicated, and that is the point rather than tidiness:
 * everything subtle in this file lives in these forty lines — the widened
 * verification window, `FILED_REASONS` not ending the search, the stamp that
 * has to survive a throw. A second copy for the lazy path would be a second
 * place for each of those to drift, and the drift would show up as a payment
 * recovered on one trigger and filed on the other.
 */
async function examineOrder(
  order: Order,
  wallet: string,
  fetcher: RecoveryFetcher,
): Promise<{ recovered: boolean; filed: boolean }> {
  const fetchSignaturePage = fetcher.signatures ?? defaultFetchSignaturesPage;
  let orderFiled = false;
  let orderRecovered = false;

  // The age bound, and the only thing it does: past it the verification
  // window narrows back to the order's own, so a payment found here can be
  // recorded but can never be seated. See RECOVERY_MAX_AGE_DAYS.
  const withinRecoveryWindow = Date.now() - order.expiresAt.getTime() <= RECOVERY_MAX_AGE_MS;

  try {
    const candidates = await collectOldestCandidates(
      fetchSignaturePage,
      order.id,
      order.referencePubkey,
      order.createdAt.getTime(),
    );

    for (const signature of candidates) {
      const verified = await verifySolPayment({
        signature,
        expectedLamports: order.amountLamports,
        wallet,
        expectedPayer: order.payerPubkey ?? undefined,
        // See the widened-window paragraph on `recoverUnclaimedOrders`.
        createdAtMs: order.createdAt.getTime(),
        expiresAtMs: withinRecoveryWindow ? Date.now() : order.expiresAt.getTime(),
        fetchTransaction: fetcher.transaction,
      });

      const result = await settlePayment({ order, signature, verified });

      if (result.ok) {
        orderRecovered = true;
        break;
      }

      if (FILED_REASONS.has(result.reason) && !orderFiled) {
        orderFiled = true;
      }

      // Not a break: signature_reused, a filed verdict, or a verdict
      // settlePayment leaves entirely unclaimed all mean only that THIS
      // candidate is not (or is no longer usable as) this order's payment.
      // The next one might still be — see `recoverUnclaimedOrders`'s comment.
    }
  } finally {
    // Examined either way — settled, filed, exhausted its candidates
    // without a verdict, or the search itself threw: this is what lets
    // the next pass move on to different candidates instead of re-reading
    // this row forever. See `unclaimedOrders` and `recoverUnclaimedOrders`
    // on why the stamp must survive a throw, not just the happy path.
    //
    // The lazy path stamps this column a second time, up front, to claim the
    // order against a concurrent request — see `claimForRecovery` in
    // `lazy-recovery.ts`. Stamping again here is not a conflict: both writes
    // mean the same thing ("a pass has been at this row"), and moving it
    // forward is what stops the next pass re-reading it.
    await execute(`UPDATE entry_orders SET recovery_attempted_at = now() WHERE id = $1`, [order.id]);
  }

  return { recovered: orderRecovered, filed: orderFiled };
}

/**
 * Recovery for ONE named order, which is what the lazy request-path trigger
 * runs. `lazy-recovery.ts` is the only caller — see `reconcileOnRead` there,
 * and `src/app/api/orders/[id]/route.ts` for where that is invoked.
 *
 * Deliberately NOT a filter on `unclaimedOrders`: the pass's candidate query
 * exists to spread a bounded RPC budget fairly across a backlog, and this has
 * no backlog to be fair to. It has one order, named by the person waiting on
 * it, and the caller has already decided that order is worth a look.
 *
 * The `status = 'expired'` precondition still holds, and is checked by the
 * claim rather than here: a `pending` order has a live payer and `/confirm`
 * is its path; a `paid` or `failed` order has nothing left to recover.
 */
export async function recoverOrder(
  orderId: string,
  fetcher: RecoveryFetcher = {},
): Promise<{ recovered: boolean; filed: boolean }> {
  const wallet = paymentWallet();
  if (!wallet.ok) {
    console.error(`recoverOrder: ${wallet.reason}`);
    return { recovered: false, filed: false };
  }

  const order = await orderById(orderId);
  if (!order || order.status !== "expired") return { recovered: false, filed: false };

  return examineOrder(order, wallet.address, fetcher);
}

/**
 * Candidates for recovery: orders whose payment window closed without a
 * payment ever landing. A `pending` order still has a live payer polling
 * `/confirm`; a `paid` or `failed` order has nothing left to recover.
 *
 * `recovery_attempted_at IS NULL` sorts first (`NULLS FIRST`): an order no
 * pass has ever looked at outranks one already checked and found wanting, so
 * — combined with `recoverUnclaimedOrders` stamping every order it examines,
 * even one it threw on — a pass makes forward progress through the whole
 * candidate set instead of re-reading the same oldest rows every single time
 * (migration 004's own comment has the full failure mode this closes). Ties
 * (including "never examined", where every value is the same NULL) break on
 * `expires_at DESC`: the most-recently-expired orders are the only ones
 * still inside `LATE_CONFIRM_GRACE_MINUTES` of their own expiry, i.e. the
 * only ones a settlement can still reclaim a colour for rather than merely
 * file, so among equally-unexamined candidates those get first look.
 *
 * There is deliberately NO age bound here any more. It used to sit in this
 * WHERE clause, where it stopped an old payment being recovered and, in the
 * same stroke, stopped it being FILED — money in our wallet with no row in
 * any table and nobody able to see it. `RECOVERY_MAX_AGE_DAYS` now bounds
 * only what a pass may seat (see its own comment and the caller above); what
 * a pass may record is bounded by nothing, because a payment nobody can see
 * is a payment nobody can return.
 *
 * What that costs is the pass never running out of candidates once a war has
 * left a tail of abandoned reservations behind it. The ordering is what
 * keeps it survivable: `NULLS FIRST` means a freshly expired order — the
 * only kind that can still be seated — is always examined before any order
 * a pass has already looked at, so an old backlog delays nothing that
 * matters, it only keeps spending one cheap signature fetch per leftover
 * slot. `MAX_ORDERS_PER_PASS` is what bounds that spend, and it is unchanged.
 *
 * Reads through `orderById` rather than mapping `entry_orders` rows a second
 * time, so this file carries no second copy of that mapping to drift from
 * the one in orders.ts.
 */
async function unclaimedOrders(limit: number): Promise<Order[]> {
  const rows = await query<{ id: string }>(
    `SELECT id FROM entry_orders
      WHERE status = 'expired'
      ORDER BY recovery_attempted_at ASC NULLS FIRST, expires_at DESC
      LIMIT $1`,
    [limit],
  );

  const orders: Order[] = [];
  for (const row of rows) {
    const order = await orderById(row.id);
    if (order) orders.push(order);
  }
  return orders;
}

/**
 * Assembles one order's candidate signatures, oldest first, capped at
 * `MAX_SIGNATURES_PER_REFERENCE`.
 *
 * This is the fix for the attack `getSignaturesForAddress`'s newest-first
 * ordering otherwise enables: the reference only becomes public once the
 * payer's own transfer lands on chain (it is a read-only account in that
 * transaction, and is returned to the browser no earlier). Nobody can build
 * a transaction naming a reference they have not yet observed, so no
 * outsider can ever get in front of the payer's FIRST transaction against
 * it. That is the whole guarantee, and it is deliberately weaker than "the
 * real payment is the oldest": a payer who underpays and then tops up has a
 * settling transaction that is not the oldest, which is why this keeps the
 * oldest `MAX_SIGNATURES_PER_REFERENCE` rather than only the single oldest.
 * The residual is narrow and worth naming: if the payer's first attempt is
 * not the one that settles, an outsider who wins a seconds-wide race could
 * fill the remaining slots. That needs a precondition the plain attack did
 * not.
 *
 * Taking the newest few (the original shape) is exactly backward for that
 * reason: enough recent junk, all sent after the real payment, pushes the
 * one transaction that matters out of a fixed-size newest-first window
 * entirely — permanently, since a reference that has already collected five
 * newer dust transfers collects the identical five again on every future
 * pass. Paging backward and keeping the oldest few instead means a real
 * payment survives any amount of newer dust, up to the page ceiling below.
 *
 * Paging stops, and the search is considered complete, the moment a page's
 * oldest entry has a block time at or before `createdAtMs`: a fresh
 * reference has no history before the order that minted it, so a
 * transaction that old cannot be the real payment, and everything newer than
 * it has, by construction, already been collected in an earlier page. Paging
 * also stops on an empty or short page (there is no more history to fetch)
 * or after `SIGNATURE_PAGE_CEILING` pages, whichever comes first; the last
 * case is logged (see below), since it means a reference has more than
 * `SIGNATURE_PAGE_SIZE * SIGNATURE_PAGE_CEILING` transactions naming it
 * without the boundary ever being found, which is not something a well-
 * behaved order produces on its own.
 *
 * This widens the *fetch* only: `getTransaction` — the expensive per-
 * signature RPC call `verifyPayment` makes — is still capped at
 * `MAX_SIGNATURES_PER_REFERENCE` regardless of how many pages were fetched
 * to find those candidates; only the cheaper, batchable
 * `getSignaturesForAddress` calls scale with `SIGNATURE_PAGE_CEILING`.
 */
async function collectOldestCandidates(
  fetchPage: SignaturesPageFetcher,
  orderId: string,
  reference: string,
  createdAtMs: number,
): Promise<string[]> {
  const collected: SignatureCandidate[] = [];
  let before: string | undefined;
  let stoppedEarly = false;

  for (let page = 0; page < SIGNATURE_PAGE_CEILING; page++) {
    const entries = await fetchPage(reference, before);
    if (entries.length === 0) {
      stoppedEarly = true;
      break;
    }
    collected.push(...entries);

    const oldestInPage = entries[entries.length - 1];
    const pageCoversCreation =
      typeof oldestInPage.blockTime === "number" && oldestInPage.blockTime * 1000 <= createdAtMs;
    const noMoreHistory = entries.length < SIGNATURE_PAGE_SIZE;

    if (pageCoversCreation || noMoreHistory) {
      stoppedEarly = true;
      break;
    }
    before = oldestInPage.signature;
  }

  if (!stoppedEarly) {
    // The page ceiling was reached without ever finding a transaction at or
    // before this order's own createdAt — a flood, not ordinary usage. Made
    // visible rather than silently retried every pass, since nothing here
    // can distinguish "extraordinary but real" from "an attacker is
    // deliberately burying this order's payment".
    console.error(
      `recoverUnclaimedOrders: order ${orderId}, reference ${reference} — reached the ` +
        `${SIGNATURE_PAGE_CEILING}-page ceiling (${collected.length} transactions seen) ` +
        `without finding one at or before the order's own createdAt; examining the oldest ` +
        `${MAX_SIGNATURES_PER_REFERENCE} found so far.`,
    );
  }

  // Anything at or before createdAt cannot be this order's payment (see the
  // function's own doc comment) and would only waste a verification slot —
  // excluded here rather than left for verifyPayment's own window check to
  // reject one candidate at a time.
  const relevant = collected.filter(
    (entry) => entry.blockTime === null || entry.blockTime * 1000 > createdAtMs,
  );

  const oldestFirst = relevant.slice().reverse();
  return oldestFirst.slice(0, MAX_SIGNATURES_PER_REFERENCE).map((entry) => entry.signature);
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Real `getSignaturesForAddress` call, retried across endpoints with backoff
 * exactly like `solana.ts`'s `defaultFetchTransaction` — the same node can be
 * having a bad moment for either RPC method, and the same rotation-plus-
 * backoff shape covers it here without inventing a second policy.
 */
async function defaultFetchSignaturesPage(
  reference: string,
  before?: string,
): Promise<SignatureCandidate[]> {
  const endpoints = solanaRpcUrls();
  let lastError: unknown = new Error("No RPC endpoint configured");

  for (let attempt = 0; attempt < RPC_MAX_ATTEMPTS; attempt++) {
    const endpoint = endpoints[attempt % endpoints.length];
    try {
      const entries = await callGetSignaturesForAddress(endpoint, reference, before);
      return entries
        .filter((entry): entry is { signature: string; blockTime?: number | null } =>
          Boolean(entry.signature),
        )
        .map((entry) => ({ signature: entry.signature, blockTime: entry.blockTime ?? null }));
    } catch (error) {
      lastError = error;
      if (attempt < RPC_MAX_ATTEMPTS - 1) {
        await sleep(Math.min(RPC_BACKOFF_MS * 2 ** attempt, RPC_BACKOFF_MAX_MS));
      }
    }
  }

  throw lastError;
}

type RawSignatureEntry = { signature?: string; blockTime?: number | null };

async function callGetSignaturesForAddress(
  endpoint: string,
  reference: string,
  before: string | undefined,
): Promise<RawSignatureEntry[]> {
  const params: { limit: number; commitment: string; before?: string } = {
    limit: SIGNATURE_PAGE_SIZE,
    commitment: RPC_COMMITMENT,
  };
  if (before) params.before = before;

  const response = await fetch(endpoint, {
    method: "POST",
    headers: { "content-type": "application/json" },
    signal: AbortSignal.timeout(12_000),
    cache: "no-store",
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "getSignaturesForAddress",
      params: [reference, params],
    }),
  });

  if (!response.ok) throw new Error(`RPC responded ${response.status}`);
  const payload = (await response.json()) as { result?: RawSignatureEntry[]; error?: unknown };
  if (payload.error) throw new Error("RPC returned an error");
  return payload.result ?? [];
}

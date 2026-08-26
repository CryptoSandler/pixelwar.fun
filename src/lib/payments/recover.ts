import { execute, query } from "../db";
import { paymentWallet, RPC_BACKOFF_MAX_MS, RPC_BACKOFF_MS, RPC_COMMITMENT, RPC_MAX_ATTEMPTS, solanaRpcUrls, usdToBaseUnits } from "./config";
import { orderById, type Order } from "./orders";
import { settlePayment, type SettleFailureReason } from "./settle";
import { verifyPayment, type TransactionFetcher } from "./solana";

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
 * one. See the loop below for how that is kept true.
 *
 * Every order this function can help has already expired unpaid — a fresh
 * `pending` order still has a payer's own browser polling `/confirm` for it,
 * and there is nothing to "recover" yet. Settlement itself is entirely
 * `settlePayment`'s: this function's only job is finding the signature and
 * handing it over. Two ways to mark an order paid is two places for them to
 * disagree, and settlement is where a mistake costs somebody real money.
 */

/** Fetches the signatures of every transaction that ever touched one reference account. */
export type SignaturesFetcher = (reference: string) => Promise<string[]>;

export type RecoveryFetcher = {
  /**
   * Signatures whose transaction named this order's reference account, in
   * the order the chain returns them (newest first from a real
   * `getSignaturesForAddress`). Defaults to a real RPC call. Untrusted —
   * see the module doc comment — and capped at `MAX_SIGNATURES_PER_REFERENCE`
   * regardless of how many this returns.
   */
  signatures?: SignaturesFetcher;
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
 * `getSignaturesForAddress` call this function makes per order. A recovery
 * pass that exhausts the quota to rescue old payments would break the
 * checkout it exists to protect. Called "lazily today" and, later, on a
 * schedule (Batch E's reconcile cron); either caller can simply run this
 * again a moment later to keep working through a longer backlog — which is
 * only true because `recovery_attempted_at` (see `unclaimedOrders` below)
 * makes each pass advance to different candidates instead of re-reading the
 * same twenty rows forever.
 */
const MAX_ORDERS_PER_PASS = 20;

/**
 * How many signatures we ask the chain for, and act on, per reference. A
 * reference is minted for one order and should have at most one real
 * transfer; a handful of extra slots covers a payer who retried (e.g.
 * topping up an underpayment) in a second transaction against the same
 * reference — or, since the reference is public the moment the real payment
 * lands (see the module doc comment), a stranger naming it in a handful of
 * junk transactions. Enforced twice: sent as the RPC request's own `limit`
 * (`callGetSignaturesForAddress` below), and sliced again on whatever comes
 * back, so an injected fetcher — or an endpoint that simply ignores the
 * request parameter — cannot hand this function an unbounded list to work
 * through.
 */
const MAX_SIGNATURES_PER_REFERENCE = 5;

/**
 * How long an expired order stays a recovery candidate at all, regardless of
 * `recovery_attempted_at`. A real payment that is ever going to show up on
 * the chain does so within minutes to hours of the order expiring — Solana
 * confirms in seconds, and even a payer whose wallet held a signed transfer
 * unbroadcast for a while has no plausible reason to broadcast it a week
 * later. Seven days is generous slack past that for a slow retry while still
 * being short enough that abandoned reservations — the overwhelming majority
 * of expired orders — eventually age out of the candidate set entirely,
 * rather than sitting in it, unresolvable, forever.
 */
const RECOVERY_MAX_AGE_DAYS = 7;

/**
 * `settlePayment` failure reasons that mean a real payment was written to
 * `unmatched_payments` — see `fileUnmatched`'s call sites in settle.ts. Not
 * every failure reason gets here: `signature_reused`, the "never spendable
 * anywhere" verdicts (`failed_tx`/`wrong_token`/`wrong_destination`) and the
 * retryable ones (`not_confirmed`/`rpc_unavailable`/`no_block_time`/
 * `invalid_signature`) all leave nothing behind, by design — see
 * `handleVerificationFailure`'s own doc comment in settle.ts.
 *
 * Critically, `wrong_payer` and `insufficient_amount` also leave the
 * signature itself unclaimed (`settle.ts`'s `handleVerificationFailure`
 * never reaches `consumed_signatures` for either) — a junk candidate that
 * lands on one of these verdicts today will land on the exact same verdict
 * again tomorrow. A reason being in this set means "record it", never
 * "stop looking" — see the loop below.
 */
const FILED_REASONS = new Set<SettleFailureReason>([
  "unmatched",
  "wrong_payer",
  "insufficient_amount",
  "already_settled",
]);

/**
 * Runs one recovery pass.
 *
 * For each expired, still-unpaid order (capped at `MAX_ORDERS_PER_PASS`,
 * least-recently-examined first — see `unclaimedOrders`), asks the chain for
 * signatures that touched its reference and tries every one, in the order
 * the chain returned them (capped at `MAX_SIGNATURES_PER_REFERENCE`), until
 * one settles the order.
 *
 * A filed verdict (`FILED_REASONS`) does not stop the search: it means
 * *this candidate* is not this order's payment — a stray transfer that
 * merely named the reference, or a genuine underpayment — not that the
 * order has nothing to find. `wrong_payer` and `insufficient_amount`
 * specifically leave the signature unclaimed (see `FILED_REASONS`'s own
 * comment), so treating them as a reason to stop would make one cheap junk
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

  const fetchSignatures = fetcher.signatures ?? defaultFetchSignatures;
  const orders = await unclaimedOrders(MAX_ORDERS_PER_PASS);

  for (const order of orders) {
    const candidates = (await fetchSignatures(order.referencePubkey)).slice(
      0,
      MAX_SIGNATURES_PER_REFERENCE,
    );

    let orderFiled = false;

    for (const signature of candidates) {
      const verified = await verifyPayment({
        signature,
        expectedBaseUnits: usdToBaseUnits(order.amountUsd),
        wallet: wallet.address,
        expectedPayer: order.payerPubkey ?? undefined,
        // See the widened-window paragraph on this function.
        createdAtMs: order.createdAt.getTime(),
        expiresAtMs: Date.now(),
        fetchTransaction: fetcher.transaction,
      });

      const result = await settlePayment({ order, signature, verified });

      if (result.ok) {
        recovered.push(order.id);
        break;
      }

      if (FILED_REASONS.has(result.reason) && !orderFiled) {
        filed.push(order.id);
        orderFiled = true;
      }

      // Not a break: signature_reused, a filed verdict, or a verdict
      // settlePayment leaves entirely unclaimed all mean only that THIS
      // candidate is not (or is no longer usable as) this order's payment.
      // The next one might still be — see the function's own doc comment.
    }

    // Examined either way, whatever was found: this is what lets the next
    // pass move on to different candidates instead of re-reading this row
    // forever. See `unclaimedOrders`.
    await execute(`UPDATE entry_orders SET recovery_attempted_at = now() WHERE id = $1`, [order.id]);
  }

  return { recovered, filed };
}

/**
 * Candidates for recovery: orders whose payment window closed without a
 * payment ever landing. A `pending` order still has a live payer polling
 * `/confirm`; a `paid` or `failed` order has nothing left to recover.
 *
 * `recovery_attempted_at IS NULL` sorts first (`NULLS FIRST`): an order no
 * pass has ever looked at outranks one already checked and found wanting, so
 * — combined with `recoverUnclaimedOrders` stamping every order it examines
 * — a pass makes forward progress through the whole candidate set instead of
 * re-reading the same oldest rows every single time (migration 004's own
 * comment has the full failure mode this closes). Ties (including "never
 * examined", where every value is the same NULL) break on `expires_at DESC`:
 * the most-recently-expired orders are the only ones still inside
 * `LATE_CONFIRM_GRACE_MINUTES` of their own expiry, i.e. the only ones a
 * settlement can still reclaim a colour for rather than merely file, so among
 * equally-unexamined candidates those get first look.
 *
 * `RECOVERY_MAX_AGE_DAYS` keeps a genuinely dead order — the ordinary,
 * abandoned reservation nobody ever paid for — from being a candidate
 * forever: without it, a large enough backlog of those still limits how much
 * of the truly live set fits in one `MAX_ORDERS_PER_PASS`-sized pass, even
 * with the progress marker rotating through them.
 *
 * Reads through `orderById` rather than mapping `entry_orders` rows a second
 * time, so this file carries no second copy of that mapping to drift from
 * the one in orders.ts.
 */
async function unclaimedOrders(limit: number): Promise<Order[]> {
  const rows = await query<{ id: string }>(
    `SELECT id FROM entry_orders
      WHERE status = 'expired' AND expires_at > now() - ($1 || ' days')::interval
      ORDER BY recovery_attempted_at ASC NULLS FIRST, expires_at DESC
      LIMIT $2`,
    [String(RECOVERY_MAX_AGE_DAYS), limit],
  );

  const orders: Order[] = [];
  for (const row of rows) {
    const order = await orderById(row.id);
    if (order) orders.push(order);
  }
  return orders;
}

type SignatureEntry = { signature?: string };

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Real `getSignaturesForAddress` call, retried across endpoints with backoff
 * exactly like `solana.ts`'s `defaultFetchTransaction` — the same node can be
 * having a bad moment for either RPC method, and the same rotation-plus-
 * backoff shape covers it here without inventing a second policy.
 */
async function defaultFetchSignatures(reference: string): Promise<string[]> {
  const endpoints = solanaRpcUrls();
  let lastError: unknown = new Error("No RPC endpoint configured");

  for (let attempt = 0; attempt < RPC_MAX_ATTEMPTS; attempt++) {
    const endpoint = endpoints[attempt % endpoints.length];
    try {
      const entries = await callGetSignaturesForAddress(endpoint, reference);
      return entries
        .map((entry) => entry.signature)
        .filter((signature): signature is string => Boolean(signature));
    } catch (error) {
      lastError = error;
      if (attempt < RPC_MAX_ATTEMPTS - 1) {
        await sleep(Math.min(RPC_BACKOFF_MS * 2 ** attempt, RPC_BACKOFF_MAX_MS));
      }
    }
  }

  throw lastError;
}

async function callGetSignaturesForAddress(
  endpoint: string,
  reference: string,
): Promise<SignatureEntry[]> {
  const response = await fetch(endpoint, {
    method: "POST",
    headers: { "content-type": "application/json" },
    signal: AbortSignal.timeout(12_000),
    cache: "no-store",
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "getSignaturesForAddress",
      params: [reference, { limit: MAX_SIGNATURES_PER_REFERENCE, commitment: RPC_COMMITMENT }],
    }),
  });

  if (!response.ok) throw new Error(`RPC responded ${response.status}`);
  const payload = (await response.json()) as { result?: SignatureEntry[]; error?: unknown };
  if (payload.error) throw new Error("RPC returned an error");
  return payload.result ?? [];
}

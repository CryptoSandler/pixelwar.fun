import { query } from "../db";
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
 * key", and because the key was minted for exactly one order and never
 * reused, whatever comes back is that order's own payment, no signature
 * pasted by anyone required.
 *
 * That is the case this pass exists for: a payer signs a transfer, the
 * wallet asks them to approve it, and they close the tab before the browser
 * ever calls `/confirm`. The money still lands in our wallet. Without this
 * pass nothing would ever go looking for it again.
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
   * `getSignaturesForAddress`). Defaults to a real RPC call.
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
 * schedule (Batch E's reconcile cron) — either caller can simply run this
 * again a moment later to keep working through a longer backlog.
 */
const MAX_ORDERS_PER_PASS = 20;

/**
 * How many signatures we ask the chain for per reference. A reference is
 * minted for one order and attached to at most one real transfer; a handful
 * of extra slots only covers a payer who retried (e.g. topping up an
 * underpayment) in a second transaction against the same reference.
 */
const MAX_SIGNATURES_PER_REFERENCE = 5;

/**
 * `settlePayment` failure reasons that mean a real payment was written to
 * `unmatched_payments` — see `fileUnmatched`'s call sites in settle.ts. Not
 * every failure reason gets here: `signature_reused`, the "never spendable
 * anywhere" verdicts (`failed_tx`/`wrong_token`/`wrong_destination`) and the
 * retryable ones (`not_confirmed`/`rpc_unavailable`/`no_block_time`/
 * `invalid_signature`) all leave nothing behind, by design — see
 * `handleVerificationFailure`'s own doc comment in settle.ts.
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
 * oldest first — the payments that have been waiting longest get looked at
 * first), asks the chain for signatures that touched its reference and
 * tries each one, in the order the chain returned them, until one either
 * settles the order or gets filed for support. A signature that turns out to
 * belong to someone else's already-settled payment, or that could never
 * have paid anything (an on-chain failure, the wrong token, the wrong
 * wallet), is skipped in favour of the next one — a reference should have
 * exactly one real transfer, but "should" is not "does", and skipping costs
 * nothing.
 *
 * `verifyPayment` is called with a widened window rather than the order's
 * own `createdAt`/`expiresAt`. Elsewhere (`/confirm`), that window is the
 * only thing standing between a fixed price and a bearer instrument: without
 * it, any unspent transfer of the right size, ever made to our wallet, could
 * be claimed by whoever pasted its signature first. That risk does not exist
 * here — the signature was not pasted by anyone, it was found by asking the
 * chain what touched this order's own single-use reference key, which is a
 * strictly stronger binding than a timestamp was ever a proxy for. Keeping
 * the check anchored at "no later than right now" (rather than dropping it
 * outright) still catches the one thing it can meaningfully still catch: a
 * transaction cannot have a block time in the future. This is also what lets
 * this pass close a gap `settlePayment` cannot close on its own —
 * `verifyPayment` returns `outside_bid_window` before it ever computes an
 * amount or a sender, so a payment that arrived well outside its order's
 * *original* window is money `/confirm` could never file to
 * `unmatched_payments`, no matter how late the payer retried. Found by
 * reference instead of by a submitted signature, that same late transfer
 * clears the (widened) window check here, flows into the ordinary
 * ok/`wrong_payer`/`insufficient_amount` verdicts, and `settlePayment`
 * already knows how to record every one of those.
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
    const signatures = await fetchSignatures(order.referencePubkey);

    for (const signature of signatures) {
      const verified = await verifyPayment({
        signature,
        expectedBaseUnits: usdToBaseUnits(order.amountUsd),
        wallet: wallet.address,
        expectedPayer: order.payerPubkey ?? undefined,
        // See the widened-window comment on this function.
        createdAtMs: 0,
        expiresAtMs: Date.now(),
        fetchTransaction: fetcher.transaction,
      });

      const result = await settlePayment({ order, signature, verified });

      if (result.ok) {
        recovered.push(order.id);
        break;
      }

      if (FILED_REASONS.has(result.reason)) {
        filed.push(order.id);
        break;
      }

      // signature_reused, or a verdict settlePayment leaves entirely
      // unclaimed: this signature is not this order's payment (or is not
      // usable as one any more). Try the next signature, if there is one.
    }
  }

  return { recovered, filed };
}

/**
 * Candidates for recovery: orders whose payment window closed without a
 * payment ever landing. A `pending` order still has a live payer polling
 * `/confirm`; a `paid` or `failed` order has nothing left to recover.
 *
 * Reads through `orderById` rather than mapping `entry_orders` rows a second
 * time, so this file carries no second copy of that mapping to drift from
 * the one in orders.ts.
 */
async function unclaimedOrders(limit: number): Promise<Order[]> {
  const rows = await query<{ id: string }>(
    `SELECT id FROM entry_orders WHERE status = 'expired' ORDER BY expires_at ASC LIMIT $1`,
    [limit],
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

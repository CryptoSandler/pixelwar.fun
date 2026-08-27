import { BLOCKTIME_SKEW_SECONDS } from "./config";
import type { SolanaTransaction, TransactionFetcher } from "./solana";

/**
 * Verifying a NATIVE SOL transfer, which the USDC verifier cannot do.
 *
 * WHY THIS IS A SEPARATE FILE AND NOT A FLAG ON `verifyPayment`. That function
 * reads `preTokenBalances`/`postTokenBalances` exclusively and compares
 * against a hardcoded mint — it is a verifier of SPL token movements, and a
 * native SOL transfer produces none. Lamports move in `preBalances`/
 * `postBalances`, a different field with different semantics: those are
 * indexed by position in `accountKeys` rather than carrying an owner, and
 * they include the transaction fee, which token balances never do.
 *
 * Folding both into one function would mean one body with two disjoint
 * halves and a flag choosing between them, which is two functions wearing one
 * name. The discipline is shared and the arithmetic is not.
 *
 * THE PAYER IS DERIVED, NEVER CLAIMED. Whoever's lamports went down is the
 * payer, and that is read off the chain rather than taken from the request.
 * A caller who submits somebody else's signature therefore registers that
 * somebody, not themselves — which gains an attacker nothing and costs the
 * honest case nothing.
 */

export type SolTransferResult =
  | { ok: true; payer: string; lamports: bigint; blockTimeMs: number }
  | { ok: false; reason: SolTransferFailure; message: string };

export type SolTransferFailure =
  | "not_found"
  | "failed_on_chain"
  | "no_block_time"
  | "no_transfer"
  | "insufficient_amount"
  | "too_old"
  | "rpc_unavailable";

/**
 * How far back a transfer may be and still pay for a registration.
 *
 * A registration is not tied to an order with its own window, so something has
 * to bound how old a payment can be — otherwise any historical transfer to the
 * receiving wallet, made for any reason, could be presented as a registration
 * fee. A day is generous for a wallet that paid and closed the tab, and short
 * enough that the pool of reusable transfers stays small.
 *
 * The signature is UNIQUE in `registrations`, so a transfer can only ever pay
 * once regardless of this — this bounds which transfers are eligible, not how
 * many times one counts.
 */
export const REGISTRATION_MAX_AGE_HOURS = 24;

/**
 * The lamports `wallet` received in this transaction, and who paid them.
 *
 * `preBalances`/`postBalances` are positional: entry N is the balance of
 * `accountKeys[N]`. That is the whole reason this cannot reuse the token
 * path's `sumFor`, which matches on an `owner` field that native balances do
 * not have.
 *
 * THE FEE PAYER'S DELTA INCLUDES THE NETWORK FEE, so the payer's balance drops
 * by more than it sent. That is why the amount is read from the RECIPIENT's
 * increase rather than the sender's decrease: what matters is what arrived,
 * and only the recipient's side says that without arithmetic about fees.
 */
export function readSolTransfer(
  transaction: SolanaTransaction,
  recipient: string,
): { payer: string; lamports: bigint } | null {
  const keys = transaction?.transaction?.message?.accountKeys ?? [];
  const pre = transaction?.meta?.preBalances;
  const post = transaction?.meta?.postBalances;
  if (!pre || !post || pre.length !== post.length || keys.length !== pre.length) return null;

  let received = 0n;
  let payer: string | null = null;
  let largestDrop = 0n;

  for (let i = 0; i < keys.length; i++) {
    const pubkey = keys[i]?.pubkey;
    if (!pubkey) continue;
    const delta = BigInt(post[i] ?? 0) - BigInt(pre[i] ?? 0);

    if (pubkey === recipient && delta > 0n) received += delta;

    // The payer is the signer who lost the most. A transaction can move
    // lamports between several accounts; the one that paid for this is the
    // signer whose balance fell furthest, and requiring `signer` is what stops
    // an account that merely lost rent from being named.
    if (keys[i]?.signer && delta < 0n && -delta > largestDrop) {
      largestDrop = -delta;
      payer = pubkey;
    }
  }

  if (received <= 0n || !payer) return null;
  return { payer, lamports: received };
}

/**
 * Whether this signature paid `minLamports` to `recipient`, recently enough.
 *
 * Mirrors the USDC path's discipline deliberately: the RPC answer is treated
 * as untrusted, a transaction that failed on chain moved nothing however it
 * looks, and a missing block time is a refusal rather than an assumption —
 * a transfer whose age cannot be established cannot be checked against the
 * window.
 */
export async function verifySolTransfer(input: {
  signature: string;
  recipient: string;
  minLamports: bigint;
  fetchTransaction: TransactionFetcher;
  nowMs?: number;
}): Promise<SolTransferResult> {
  let transaction: SolanaTransaction;
  try {
    transaction = await input.fetchTransaction(input.signature);
  } catch (error) {
    console.error("verifySolTransfer: fetch failed", error);
    return {
      ok: false,
      reason: "rpc_unavailable",
      message: "Could not read that transaction just now. Try again in a moment.",
    };
  }

  if (!transaction) {
    return {
      ok: false,
      reason: "not_found",
      message: "That transaction is not on chain yet.",
    };
  }

  // A failed transaction can still be fetched and still name a recipient. It
  // moved nothing.
  if (transaction.meta?.err) {
    return { ok: false, reason: "failed_on_chain", message: "That transaction failed on Solana." };
  }

  if (typeof transaction.blockTime !== "number") {
    return {
      ok: false,
      reason: "no_block_time",
      message: "That transaction has no timestamp on chain yet. Try again in a moment.",
    };
  }

  const blockTimeMs = transaction.blockTime * 1000;
  const now = input.nowMs ?? Date.now();
  const ageMs = now - blockTimeMs;
  // Skew allowance in the future direction only, for the same reason the USDC
  // path allows it: our clock and the cluster's are not the same clock.
  if (ageMs > REGISTRATION_MAX_AGE_HOURS * 3_600_000 || ageMs < -BLOCKTIME_SKEW_SECONDS * 1000) {
    return {
      ok: false,
      reason: "too_old",
      message: "That transfer is too old to register with. Send a new one.",
    };
  }

  const transfer = readSolTransfer(transaction, input.recipient);
  if (!transfer) {
    return {
      ok: false,
      reason: "no_transfer",
      message: "That transaction did not send SOL to this deployment.",
    };
  }

  if (transfer.lamports < input.minLamports) {
    return {
      ok: false,
      reason: "insufficient_amount",
      message: "That transfer was smaller than the registration fee.",
    };
  }

  return { ok: true, payer: transfer.payer, lamports: transfer.lamports, blockTimeMs };
}

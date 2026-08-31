import { BLOCKTIME_SKEW_SECONDS, formatSol } from "./config";
import { isSignatureShaped } from "./signature";
import { defaultFetchTransaction, type SolanaTransaction, type TransactionFetcher, type VerifyResult } from "./solana";

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
    // THE NAME, NEVER THE OBJECT. A rejected `fetch` carries the URL it was
    // given — and on any paid provider that URL has an api-key in its query
    // string, so logging the error would put the key into the deployment's
    // logs. `solana.ts` avoids this by not logging at all; this path wants
    // the signal, so it takes the one field that cannot carry a secret.
    console.error(`verifySolTransfer: fetch failed (${error instanceof Error ? error.name : "unknown"})`);
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

/**
 * The admission verifier: the same discipline as `verifyPayment`, reading
 * native lamports instead of token balances.
 *
 * WHY IT RETURNS `VerifyResult` — the USDC verifier's own type — rather than
 * a shape of its own. `settlePayment` is the thing that decides whether a
 * signature is spent, an order is seated, and a stray payment is filed for a
 * human, and every one of those decisions is denomination-agnostic. Giving
 * this path its own result type would have meant a second copy of that
 * machinery to keep in step with the first, which is how two payment paths
 * drift into disagreeing about what "already settled" means.
 *
 * `amountBaseUnits` and `receivedBaseUnits` therefore carry LAMPORTS here,
 * where the USDC path put micro-dollars in them. The name is inherited and
 * imprecise; the alternative was renaming a field that appears in the
 * operator's orphan queue and in stored rows, which is worse than a name that
 * means "the smallest unit of whatever this order is denominated in".
 *
 * `wrong_token` is unreachable on this path, and deliberately so: there is no
 * token to get wrong. A transfer of the wrong ASSET simply does not move our
 * lamports, and lands as `wrong_destination`.
 */
export async function verifySolPayment(params: {
  signature: string;
  /** The order's price, in lamports. A floor: paying more is recorded, not refused. */
  expectedLamports: bigint;
  wallet: string;
  /** The wallet the order was opened from, when there is one. Only it may pay. */
  expectedPayer?: string;
  createdAtMs: number;
  expiresAtMs: number;
  fetchTransaction?: TransactionFetcher;
}): Promise<VerifyResult> {
  const signature = params.signature.trim();

  if (!isSignatureShaped(signature)) {
    return {
      ok: false,
      reason: "invalid_signature",
      message: "That does not look like a Solana transaction signature.",
    };
  }

  let transaction: SolanaTransaction;
  try {
    transaction = await (params.fetchTransaction ?? defaultFetchTransaction)(signature);
  } catch (error) {
    // The name only — never the object. See `verifySolTransfer` above: on any
    // paid provider the URL in a rejected fetch carries an api-key.
    console.error(`verifySolPayment: fetch failed (${error instanceof Error ? error.name : "unknown"})`);
    return {
      ok: false,
      reason: "rpc_unavailable",
      message: "Could not reach a Solana node to check this transaction. Try again in a moment.",
    };
  }

  if (!transaction) {
    return {
      ok: false,
      reason: "not_confirmed",
      message:
        "That transaction is not confirmed yet, or does not exist. Wait a few seconds and try again.",
    };
  }
  if (!transaction.meta) {
    return {
      ok: false,
      reason: "not_confirmed",
      message: "That transaction has no confirmed result yet. Try again in a moment.",
    };
  }
  if (transaction.meta.err !== null && transaction.meta.err !== undefined) {
    return {
      ok: false,
      reason: "failed_tx",
      message: "That transaction failed on-chain, so nothing was transferred.",
    };
  }

  const blockTime = transaction.blockTime;
  if (typeof blockTime !== "number" || !Number.isFinite(blockTime)) {
    return {
      ok: false,
      reason: "no_block_time",
      message:
        "That transaction has no confirmed block time yet, so it cannot be matched to this order. Try again in a moment.",
    };
  }

  const transfer = readSolTransfer(transaction, params.wallet);
  const received = transfer?.lamports ?? 0n;

  /**
   * The sender, from the same balances the amount comes from.
   *
   * Every signer whose lamports fell is reported, not just the largest — an
   * operator reuniting a stray payment with an order needs to see everything
   * that funded it, and the fee payer's own drop includes the network fee,
   * which is why the amount never comes from this side.
   */
  const keys = transaction.transaction?.message?.accountKeys ?? [];
  const pre = transaction.meta.preBalances ?? [];
  const post = transaction.meta.postBalances ?? [];
  const debited: { owner: string; amountBaseUnits: string }[] = [];
  for (let i = 0; i < keys.length && i < pre.length && i < post.length; i++) {
    const delta = BigInt(post[i] ?? 0) - BigInt(pre[i] ?? 0);
    const pubkey = keys[i]?.pubkey;
    if (pubkey && pubkey !== params.wallet && delta < 0n) {
      debited.push({ owner: pubkey, amountBaseUnits: (-delta).toString() });
    }
  }
  const sender = { feePayer: keys.find((key) => key.signer)?.pubkey ?? null, debited };

  const skewMs = BLOCKTIME_SKEW_SECONDS * 1000;
  const blockTimeMs = blockTime * 1000;
  if (blockTimeMs < params.createdAtMs - skewMs || blockTimeMs > params.expiresAtMs + skewMs) {
    return {
      ok: false,
      reason: "outside_bid_window",
      message:
        "That transaction was not made during this order. Pay for an order after starting it. A transfer from before the order existed cannot be used to claim it.",
      ...(received > 0n ? { receivedBaseUnits: received, sender } : {}),
    };
  }

  if (received <= 0n) {
    /**
     * `provenNotOurs` is a stronger claim here than on the USDC path, and the
     * difference is worth stating. Token balances are a sparse list a node can
     * return empty; native balances are POSITIONAL and cover every account in
     * the transaction, so arrays that line up with `accountKeys` are a
     * complete account of where lamports went. Lining up is therefore the
     * proof, and a mismatch is the only case where we cannot tell.
     */
    const readable = pre.length === post.length && keys.length === pre.length && pre.length > 0;
    return {
      ok: false,
      reason: "wrong_destination",
      message: readable
        ? "That transaction did not send SOL to our payment wallet."
        : "That transaction could not be read in full — the Solana node did not report its balances, so we cannot tell where the money went. Nothing has been recorded against this order. Wait a moment and try again.",
      provenNotOurs: readable,
    };
  }

  if (params.expectedPayer !== undefined && params.expectedPayer !== null) {
    const expectedPayer = params.expectedPayer.trim();
    const paidByExpectedWallet =
      sender.feePayer === expectedPayer || debited.some((debit) => debit.owner === expectedPayer);
    if (!paidByExpectedWallet) {
      return {
        ok: false,
        reason: "wrong_payer",
        message: "That transaction was not paid from the wallet this order was opened with.",
        receivedBaseUnits: received,
        sender,
      };
    }
  }

  if (received < params.expectedLamports) {
    return {
      ok: false,
      reason: "insufficient_amount",
      message:
        `That transaction sent ${formatSol(received)} SOL, but this order costs ` +
        `${formatSol(params.expectedLamports)}. Send at least the full price in a single transaction.`,
      receivedBaseUnits: received,
      sender,
    };
  }

  return { ok: true, amountBaseUnits: received };
}

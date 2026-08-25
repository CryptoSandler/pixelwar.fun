import {
  BLOCKTIME_SKEW_SECONDS,
  RPC_BACKOFF_MAX_MS,
  RPC_BACKOFF_MS,
  RPC_COMMITMENT,
  RPC_MAX_ATTEMPTS,
  USDC_MINT,
  formatUsdc,
  solanaRpcUrls,
} from "./config";

/**
 * Verifies that a Solana transaction really paid us.
 *
 * Written against the transaction's token balance deltas rather than its
 * instructions. A transfer can arrive as `transfer`, `transferChecked`, through
 * a CPI, or bundled with other instructions; the balance delta on our account
 * is the same in every case and cannot be faked by instruction shape.
 */

export type PaymentFailure =
  | "invalid_signature"
  | "not_found"
  | "not_confirmed"
  | "failed_tx"
  | "wrong_token"
  | "wrong_destination"
  | "insufficient_amount"
  | "wrong_payer"
  | "outside_bid_window"
  | "no_block_time"
  | "rpc_unavailable";

export type VerifyResult =
  | { ok: true; amountBaseUnits: bigint }
  | {
      ok: false;
      reason: PaymentFailure;
      message: string;
      /**
       * What actually arrived, when a real transfer reached our wallet but did
       * not match. The caller needs this to file the payment for support
       * instead of letting somebody's money vanish.
       */
      receivedBaseUnits?: bigint;
      /**
       * Who the transfer came from, when we can tell. An operator reuniting a
       * stray payment with an order is otherwise trusting an order id supplied
       * by whoever pasted the signature — which is exactly how you get talked
       * into paying an attacker's rank with a stranger's money.
       */
      sender?: SenderInfo;
    };

export type SenderInfo = {
  /** Fee payer: the first signer on the transaction. */
  feePayer: string | null;
  /**
   * Wallets whose USDC balance went DOWN in this transaction — whoever actually
   * funded it. Usually one; more than one means the operator should look
   * harder, not less.
   */
  debited: { owner: string; amountBaseUnits: string }[];
};

type TokenBalance = {
  accountIndex?: number;
  mint?: string;
  owner?: string;
  uiTokenAmount?: { amount?: string };
};

/** Enough of the parsed transaction to name who signed and paid the fee. */
type TransactionMessage = {
  accountKeys?: { pubkey?: string; signer?: boolean }[];
};

export type SolanaTransaction = {
  slot?: number;
  /** Unix seconds. Absent on very old transactions and on some light nodes. */
  blockTime?: number | null;
  transaction?: { message?: TransactionMessage };
  meta?: {
    err?: unknown;
    preTokenBalances?: TokenBalance[];
    postTokenBalances?: TokenBalance[];
  } | null;
} | null;

/** Injected so tests can drive the verifier with fixture transactions. */
export type TransactionFetcher = (signature: string) => Promise<SolanaTransaction>;

const BASE58_ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
const BASE58_INDEX: Record<string, number> = {};
for (let i = 0; i < BASE58_ALPHABET.length; i++) BASE58_INDEX[BASE58_ALPHABET[i]] = i;

/** Decodes a base58 string to bytes, or null when a character falls outside the alphabet. */
function base58Decode(input: string): Uint8Array | null {
  if (input.length === 0) return null;

  const bytes: number[] = [0];
  for (const char of input) {
    const value = BASE58_INDEX[char];
    if (value === undefined) return null;

    let carry = value;
    for (let i = 0; i < bytes.length; i++) {
      carry += bytes[i] * 58;
      bytes[i] = carry & 0xff;
      carry >>= 8;
    }
    while (carry > 0) {
      bytes.push(carry & 0xff);
      carry >>= 8;
    }
  }

  // Every leading '1' is a leading zero byte.
  for (const char of input) {
    if (char !== BASE58_ALPHABET[0]) break;
    bytes.push(0);
  }

  return Uint8Array.from(bytes.reverse());
}

/**
 * A Solana signature is 64 bytes of base58 — usually 87 or 88 characters.
 *
 * This is a small local copy of the decoder rather than a shared module:
 * nothing else in this codebase validates signature shape yet — `config.ts`
 * carries its own local copy of the same decoder for the same reason, to
 * check addresses — and the paste-a-signature input path that would want to
 * share this belongs to a later task, not this one.
 */
function isSignatureShaped(signature: string): boolean {
  const decoded = base58Decode(signature.trim());
  return decoded !== null && decoded.length === 64;
}

function sumFor(balances: TokenBalance[] | undefined, wallet: string, mint: string): bigint {
  let total = 0n;
  for (const balance of balances ?? []) {
    if (balance.owner === wallet && balance.mint === mint) {
      total += BigInt(balance.uiTokenAmount?.amount ?? "0");
    }
  }
  return total;
}

function touchedWallet(balances: TokenBalance[] | undefined, wallet: string): boolean {
  return (balances ?? []).some((balance) => balance.owner === wallet);
}

/**
 * Works out who paid, from the same balance deltas the amount comes from.
 *
 * Deliberately reports every debited owner rather than picking one: a transfer
 * routed through an aggregator has more than one, and quietly showing the first
 * would be worse than showing all of them.
 */
function senderOf(transaction: NonNullable<SolanaTransaction>, wallet: string): SenderInfo {
  const pre = transaction.meta?.preTokenBalances ?? [];
  const post = transaction.meta?.postTokenBalances ?? [];

  const owners = new Set<string>();
  for (const balance of [...pre, ...post]) {
    if (balance.owner && balance.owner !== wallet && balance.mint === USDC_MINT) {
      owners.add(balance.owner);
    }
  }

  const debited: SenderInfo["debited"] = [];
  for (const owner of owners) {
    const delta = sumFor(post, owner, USDC_MINT) - sumFor(pre, owner, USDC_MINT);
    if (delta < 0n) debited.push({ owner, amountBaseUnits: (-delta).toString() });
  }

  const feePayer =
    transaction.transaction?.message?.accountKeys?.find((key) => key.signer)?.pubkey ?? null;

  return { feePayer, debited };
}

export async function verifyPayment(params: {
  signature: string;
  /**
   * The order's price, in USDC base units. The price is fixed and a payment is
   * bound to its order by the transaction signature rather than by amount, so
   * this is a floor rather than an exact match: paying at least this much is
   * accepted, and any surplus is recorded as what actually arrived rather than
   * treated as a mismatch.
   */
  expectedBaseUnits: bigint;
  wallet: string;
  /**
   * The wallet this order was opened with, when there is one. See the comment
   * on the payer check below for what this guards against.
   */
  expectedPayer?: string;
  /**
   * The order's own window, as epoch milliseconds. The transaction must have
   * landed inside it.
   *
   * Without this, a payment is a bearer instrument: any unspent transfer ever
   * made to our wallet at or above the right price could be claimed by
   * whoever pasted its signature first. Tying the transaction to the window
   * means a transfer that predates the order cannot pay for it, however well
   * the amount matches.
   */
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

  const fetchTransaction = params.fetchTransaction ?? defaultFetchTransaction;

  let transaction: SolanaTransaction;
  try {
    transaction = await fetchTransaction(signature);
  } catch {
    return {
      ok: false,
      reason: "rpc_unavailable",
      message: "Could not reach a Solana node to check this transaction. Try again in a moment.",
    };
  }

  // getTransaction only returns a transaction once it has reached the requested
  // commitment, so null covers both "does not exist" and "not confirmed yet".
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

  // --- The transaction must belong to this order's lifetime ---------------
  const blockTime = transaction.blockTime;
  if (typeof blockTime !== "number" || !Number.isFinite(blockTime)) {
    // Refusing to guess: without a timestamp we cannot tell a fresh payment
    // from one lifted off the chain, and guessing in the caller's favour is
    // exactly the hole this check exists to close.
    return {
      ok: false,
      reason: "no_block_time",
      message:
        "That transaction has no confirmed block time yet, so it cannot be matched to this order. Try again in a moment.",
    };
  }

  const skewMs = BLOCKTIME_SKEW_SECONDS * 1000;
  const blockTimeMs = blockTime * 1000;
  if (blockTimeMs < params.createdAtMs - skewMs || blockTimeMs > params.expiresAtMs + skewMs) {
    return {
      ok: false,
      reason: "outside_bid_window",
      message:
        "That transaction was not made during this order. Pay for an order after starting it. A transfer from before the order existed cannot be used to claim it.",
    };
  }

  const { preTokenBalances, postTokenBalances } = transaction.meta;

  const received =
    sumFor(postTokenBalances, params.wallet, USDC_MINT) -
    sumFor(preTokenBalances, params.wallet, USDC_MINT);

  if (received <= 0n) {
    // Distinguish "paid the wrong token" from "paid someone else" so the person
    // who just spent money is told which mistake they made.
    const walletGotSomething =
      touchedWallet(postTokenBalances, params.wallet) ||
      touchedWallet(preTokenBalances, params.wallet);

    return walletGotSomething
      ? {
          ok: false,
          reason: "wrong_token",
          message:
            "That transaction moved a different token. Orders are paid in USDC on Solana. Check you sent the real USDC mint.",
        }
      : {
          ok: false,
          reason: "wrong_destination",
          message: "That transaction did not send USDC to our payment wallet.",
        };
  }

  /**
   * When the order was opened from a connected wallet, only that wallet can pay
   * it.
   *
   * Without this, a fixed price plus signature-only binding means anyone
   * watching the chain can take a stranger's transfer and claim it against their
   * own order — first call to /confirm wins the consumed_signatures race, and
   * the person who actually paid gets nothing. The paste-a-signature fallback
   * has no connected wallet and therefore no expected payer; that path is
   * first-to-claim inside the order's window, and the rules page says so.
   *
   * Checked ahead of the amount on purpose. It leaks nothing: the transaction
   * and its amount are already public to anyone holding the signature, so
   * checking order costs nothing extra. It matters because the two failures
   * are not equally fixable — an underpayment can be topped up from the same
   * wallet, but a wrong-wallet payment cannot be fixed by sending more from
   * that same wrong wallet. Telling someone "you underpaid" when the real
   * problem is whose wallet it came from sends them straight into a second
   * rejection.
   *
   * Gated on the field being present, not on it being truthy. `if
   * (params.expectedPayer)` reads tidier but is wrong: it would treat an
   * empty string the same as "no binding requested" and skip this whole
   * check — not "no match found", but "no check performed", which is a false
   * `ok: true` on exactly the thing this check exists to catch. A present but
   * blank or malformed value instead flows into the comparison below, can
   * never equal a real address, and fails closed as `wrong_payer`.
   */
  if (params.expectedPayer !== undefined && params.expectedPayer !== null) {
    const expectedPayer = params.expectedPayer.trim();
    const sender = senderOf(transaction, params.wallet);
    const paidByExpectedWallet =
      sender.feePayer === expectedPayer ||
      sender.debited.some((debit) => debit.owner === expectedPayer);

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

  // The price is fixed and a payment is bound to its order by the
  // transaction signature, not by amount, so paying more than required is not
  // a mismatch — it is simply recorded as what arrived. Paying less is still a
  // hard failure: this is a price floor, not a window around an exact amount.
  const required = params.expectedBaseUnits;
  if (received < required) {
    return {
      ok: false,
      reason: "insufficient_amount",
      message:
        `That transaction sent ${formatUsdc(received)} USDC, but this order costs ` +
        `${formatUsdc(required)}. Send at least the full price in a single transaction.`,
      receivedBaseUnits: received,
      sender: senderOf(transaction, params.wallet),
    };
  }

  return { ok: true, amountBaseUnits: received };
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * A confirmed transaction that genuinely does not exist and a node that is
 * rate-limiting us both look like "no result". Retrying across endpoints with
 * backoff is what keeps the second case from being reported to a paying user as
 * the first.
 */
async function defaultFetchTransaction(signature: string): Promise<SolanaTransaction> {
  const endpoints = solanaRpcUrls();
  let lastError: unknown = new Error("No RPC endpoint configured");

  for (let attempt = 0; attempt < RPC_MAX_ATTEMPTS; attempt++) {
    // Rotate endpoints so a single bad node does not eat every attempt.
    const endpoint = endpoints[attempt % endpoints.length];
    try {
      return await callGetTransaction(endpoint, signature);
    } catch (error) {
      lastError = error;
      if (attempt < RPC_MAX_ATTEMPTS - 1) {
        // Capped so a retry cannot hold a request open for long. Attempts are
        // sequential, so they never multiply concurrent connections; the cap is
        // about how long one request can occupy a worker.
        await sleep(Math.min(RPC_BACKOFF_MS * 2 ** attempt, RPC_BACKOFF_MAX_MS));
      }
    }
  }

  throw lastError;
}

async function callGetTransaction(
  endpoint: string,
  signature: string,
): Promise<SolanaTransaction> {
  const response = await fetch(endpoint, {
    method: "POST",
    headers: { "content-type": "application/json" },
    signal: AbortSignal.timeout(12_000),
    cache: "no-store",
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "getTransaction",
      params: [
        signature,
        {
          encoding: "jsonParsed",
          commitment: RPC_COMMITMENT,
          maxSupportedTransactionVersion: 0,
        },
      ],
    }),
  });

  if (!response.ok) throw new Error(`RPC responded ${response.status}`);
  const payload = (await response.json()) as { result?: SolanaTransaction; error?: unknown };
  if (payload.error) throw new Error("RPC returned an error");
  return payload.result ?? null;
}

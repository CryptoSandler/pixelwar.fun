import {
  RPC_BACKOFF_MAX_MS,
  RPC_BACKOFF_MS,
  RPC_COMMITMENT,
  RPC_MAX_ATTEMPTS,
  solanaRpcUrls,
} from "./config";

/**
 * The shared vocabulary of a payment check, and the one fetcher both
 * verifiers use.
 *
 * THE USDC VERIFIER THAT LIVED HERE IS GONE. Admission is charged in SOL
 * since migration 015, so `verifyPayment` — and `sumFor`, `senderOf` and
 * `reportsAttributedUsdc` with it — had no caller anywhere. See DECISIONES.md
 * for what was removed and why it was removed rather than left dormant.
 *
 * What stays is what both paths need: the transaction shape as the chain
 * reports it, the result union `settlePayment` reads, and
 * `defaultFetchTransaction`, whose retry, rotation, timeout and
 * error-swallowing discipline is worth having exactly once.
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
      /**
       * Only ever set on `wrong_destination`, and the difference between a
       * verdict a caller may spend a signature on and one it may not.
       *
       * `wrong_destination` is reached by our wallet appearing in neither
       * balance array — an absence, not an observation. A transaction that
       * genuinely paid somebody else produces that absence, and so does a
       * response that is merely thin: a 200 carrying a result whose
       * `preTokenBalances`/`postTokenBalances` are empty (or whose entries
       * carry no `owner`, as very old transactions do) parses perfectly and
       * says nothing at all about where the money went. `true` means the
       * response positively reported attributed USDC movement and our wallet
       * was not in it; anything else means we could not tell.
       */
      provenNotOurs?: boolean;
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
    /**
     * Native lamport balances, POSITIONAL: entry N belongs to
     * `accountKeys[N]`. Unlike the token balances above they carry no owner,
     * and the fee payer's entry includes the network fee. Read by
     * `sol-transfer.ts`, which exists because that difference makes them a
     * different verification rather than a parameter of this one.
     */
    preBalances?: number[];
    postBalances?: number[];
  } | null;
} | null;

/** Injected so tests can drive the verifier with fixture transactions. */
export type TransactionFetcher = (signature: string) => Promise<SolanaTransaction>;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * A confirmed transaction that genuinely does not exist and a node that is
 * rate-limiting us both look like "no result". Retrying across endpoints with
 * backoff is what keeps the second case from being reported to a paying user as
 * the first.
 *
 * Exported so `sol-transfer.ts` uses THIS fetcher rather than a second one
 * beside it. Both verifiers ask the chain the same question through the same
 * rotation, backoff, timeout and error discipline; two copies of that would
 * be two places for a provider's error text to leak from.
 */
export async function defaultFetchTransaction(signature: string): Promise<SolanaTransaction> {
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

import { formatSol } from "./config";

/**
 * The check that runs BEFORE a wallet is ever opened.
 *
 * WHY THIS EXISTS AT ALL, and it is not about our own correctness. Phantom
 * simulates every transaction it is handed, and a transaction that fails
 * simulation is shown to the person as **"this transaction may be
 * malicious"** — not "you are short of funds", not "this would fail". A payer
 * who is simply out of SOL is told, by their wallet, that the site they are
 * on might be trying to rob them. They do not come back.
 *
 * So the failure has to be found on our side of the dialog, and said in our
 * own words. Two questions, in this order, because the first is the common
 * case and answering it costs one cheap call:
 *
 *   1. Can this payer afford it — the amount PLUS the network fee?
 *   2. Does the transaction actually simulate against our own RPC?
 *
 * `sigVerify: false`, because the transaction has not been signed yet: that
 * is the entire point of asking before the wallet opens. Simulation checks
 * what the instructions would do, and an unsigned transaction runs through it
 * exactly as a signed one would.
 *
 * WHAT THIS IS NOT: a guarantee. Between this answer and the payer's
 * approval, a balance can move and a blockhash can age out. It converts the
 * common, silent, reputation-destroying failure into a sentence, which is a
 * different thing from making failure impossible.
 */

export type PreflightResult =
  | { ok: true; feeLamports: bigint; balanceLamports: bigint }
  | { ok: false; reason: PreflightFailure; message: string };

export type PreflightFailure =
  | "unreadable"
  | "insufficient_funds"
  | "simulation_failed"
  | "rpc_unavailable";

/** One JSON-RPC call, injected so every branch below is testable without a network. */
export type RpcCaller = (method: string, params: unknown[]) => Promise<unknown>;

/**
 * How much SOL a payer should hold on top of the transfer itself.
 *
 * The fee is asked of the chain (`getFeeForMessage`) rather than assumed, but
 * a node that will not answer must not stop somebody paying — so this is the
 * fallback, and it is the going rate for one signature. Five thousand
 * lamports is 0.000005 SOL; being wrong about it in the payer's favour costs
 * nothing, and being wrong the other way would refuse a payment that would
 * have worked.
 */
export const ASSUMED_FEE_LAMPORTS = 5_000n;

export async function preflight(input: {
  /** The unsigned transaction, base64, exactly as the browser built it. */
  transactionBase64: string;
  /** The account that will sign and pay, base58. */
  payer: string;
  /** What the transfer moves, in lamports — the amount the balance must cover beyond the fee. */
  lamports: bigint;
  rpc: RpcCaller;
}): Promise<PreflightResult> {
  let balance: bigint;
  let fee: bigint;

  try {
    const balanceResponse = (await input.rpc("getBalance", [input.payer])) as
      | { value?: number }
      | undefined;
    if (typeof balanceResponse?.value !== "number") {
      return {
        ok: false,
        reason: "rpc_unavailable",
        message: "Could not check your balance just now. Try again in a moment.",
      };
    }
    balance = BigInt(balanceResponse.value);

    // The message, not the transaction: `getFeeForMessage` takes the encoded
    // message and answers for the blockhash it carries.
    const feeResponse = (await input.rpc("getFeeForMessage", [
      messageOf(input.transactionBase64),
      { commitment: "confirmed" },
    ])) as { value?: number | null } | undefined;
    fee = typeof feeResponse?.value === "number" ? BigInt(feeResponse.value) : ASSUMED_FEE_LAMPORTS;
  } catch (error) {
    console.error(`preflight: rpc failed (${error instanceof Error ? error.name : "unknown"})`);
    return {
      ok: false,
      reason: "rpc_unavailable",
      message: "Could not reach Solana to check this. Try again in a moment.",
    };
  }

  const needed = input.lamports + fee;
  if (balance < needed) {
    const short = needed - balance;
    return {
      ok: false,
      reason: "insufficient_funds",
      // One sentence, naming the number that fixes it. The wallet would have
      // said "may be malicious" for exactly this.
      message: `You need ${formatSol(short)} more SOL for this — the price plus the network fee.`,
    };
  }

  let simulation: { value?: { err?: unknown; logs?: string[] | null } } | undefined;
  try {
    simulation = (await input.rpc("simulateTransaction", [
      input.transactionBase64,
      // Unsigned on purpose: this runs before the wallet is opened, so there
      // is no signature to verify and asking for one would fail every time.
      { sigVerify: false, commitment: "confirmed", encoding: "base64" },
    ])) as { value?: { err?: unknown; logs?: string[] | null } };
  } catch (error) {
    console.error(`preflight: simulate failed (${error instanceof Error ? error.name : "unknown"})`);
    return {
      ok: false,
      reason: "rpc_unavailable",
      message: "Could not reach Solana to check this. Try again in a moment.",
    };
  }

  if (simulation?.value?.err) {
    return {
      ok: false,
      reason: "simulation_failed",
      // Deliberately NOT the raw error. A payer reading "custom program error:
      // 0x1" learns nothing, and DESIGN.md §8 rules developer strings off the
      // screen. The logs are for our server, which is where they go.
      message: "This payment would not go through. Nothing has been charged.",
    };
  }

  return { ok: true, feeLamports: fee, balanceLamports: balance };
}

/**
 * The message half of a serialized legacy transaction, base64.
 *
 * A legacy transaction is a compact-u16 count of signatures, that many 64-byte
 * signatures, then the message. An unsigned one from `Transaction.serialize`
 * carries the count with empty signature slots, so the message begins after
 * them. Done by hand rather than by importing web3.js: this module runs on the
 * server for one arithmetic answer, and pulling the whole library in to slice
 * a buffer would be a poor trade.
 */
export function messageOf(transactionBase64: string): string {
  const bytes = Buffer.from(transactionBase64, "base64");
  // compact-u16: one byte for any count below 128, which every transaction
  // this project builds is — there is exactly one signer.
  const count = bytes[0];
  const offset = 1 + count * 64;
  return bytes.subarray(offset).toString("base64");
}

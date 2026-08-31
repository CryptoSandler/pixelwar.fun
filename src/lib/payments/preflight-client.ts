import type { Transaction } from "@solana/web3.js";

/**
 * The browser's half of the pre-flight: ask the server, before the wallet.
 *
 * ONE COPY, IMPORTED BY BOTH SCREENS. The admission checkout and the
 * registration panel each build a transfer and each open a wallet, and a
 * second copy of this would be a second place for the "ask first" rule to
 * quietly stop being true on one of them.
 *
 * A refusal here is a sentence the payer can act on. The same failure met
 * inside Phantom is "this transaction may be malicious" — which is what a
 * wallet says about somebody who is merely short of SOL. See
 * docs/wallet-warnings.md.
 *
 * A PRE-FLIGHT THAT CANNOT RUN DOES NOT BLOCK. The node may be unreachable
 * while the payer's balance is perfectly fine, and refusing then would invent
 * an outage out of our own caution. Only a definite "no" — not enough funds,
 * or a simulation the chain rejected — stops the flow.
 */
export async function preflightBlocks(
  transaction: Transaction,
  payer: string,
  lamports: bigint,
): Promise<string | null> {
  try {
    const response = await fetch("/api/preflight", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        transaction: Buffer.from(
          transaction.serialize({ requireAllSignatures: false, verifySignatures: false }),
        ).toString("base64"),
        payer,
        lamports: lamports.toString(),
      }),
    });
    const body = await response.json().catch(() => ({}));
    if (body?.ok === true) return null;
    if (body?.reason === "insufficient_funds" || body?.reason === "simulation_failed") {
      return typeof body.message === "string" ? body.message : "This payment would not go through.";
    }
    return null;
  } catch {
    return null;
  }
}

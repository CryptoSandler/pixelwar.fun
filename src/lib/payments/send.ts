import type { Connection, Transaction } from "@solana/web3.js";

/**
 * Handing a transaction to a wallet, with the two things Phantom cares about
 * made explicit.
 *
 * ONE SIGNER, ALWAYS. Every transaction this project builds is a single
 * `SystemProgram.transfer` paid for by the person approving it — the Solana
 * Pay reference rides along as a read-only, NON-signing account. A second
 * required signature would mean a wallet is being asked to approve something
 * somebody else must also sign, which is the shape of every drainer prompt
 * anybody has ever been trained to fear. So it is asserted here, before the
 * wallet opens, rather than assumed from the builder that happens to be
 * upstream today.
 *
 * `signAndSendTransaction`, NOT sign-then-send. The wallet broadcasts, so
 * there is no window in which this application holds a signed transaction it
 * could replay, delay or drop. Phantom's own adapter already routes
 * `sendTransaction` there; going through the Wallet Standard feature when it
 * exists is what lets the CHAIN be named out loud.
 *
 * THE CHAIN IS NAMED WHERE IT CAN BE. `solana:signAndSendTransaction` takes a
 * `chain` argument and this passes `solana:mainnet`. The injected Phantom
 * provider takes no such argument — it signs against whatever network the
 * person set in their own wallet — so on that path the chain is enforced
 * instead by the two checks that do not depend on the wallet: `paymentSafety`
 * refuses to open a wallet when the deployment's cluster and the adapter's
 * disagree, and the money routes refuse server-side when the upstream is not
 * mainnet. That ceiling is stated rather than papered over: a testnet-mode
 * wallet is the third warning in docs/wallet-warnings.md, and it is diagnosed
 * there rather than prevented here.
 */

export const MAINNET_CHAIN = "solana:mainnet";

export class MultipleSignersError extends Error {
  constructor(count: number) {
    super(`This transaction needs ${count} signatures and must need exactly one.`);
    this.name = "MultipleSignersError";
  }
}

/**
 * Throws unless exactly one signature is required, and it is this payer's.
 *
 * Reads the transaction's own account metas rather than a count kept
 * alongside it: the question is what a wallet will be asked to sign, and only
 * the transaction can answer that.
 */
export function requireSingleSigner(transaction: Transaction, payer: string): void {
  const signers = new Set<string>();
  for (const instruction of transaction.instructions) {
    for (const key of instruction.keys) {
      if (key.isSigner) signers.add(key.pubkey.toBase58());
    }
  }
  if (transaction.feePayer) signers.add(transaction.feePayer.toBase58());

  if (signers.size !== 1) throw new MultipleSignersError(signers.size);
  if (!signers.has(payer)) {
    throw new MultipleSignersError(signers.size);
  }
}

/** The shape of the adapter call this project already uses. */
export type AdapterSend = (
  transaction: Transaction,
  connection: Connection,
  options?: { preflightCommitment?: string },
) => Promise<string>;

/**
 * Sends, preferring the Wallet Standard feature so the chain can be named.
 *
 * `standard` is the connected wallet's feature map when the adapter exposes
 * one. Nothing is faked when it is absent: the adapter's own path is used,
 * and it reaches the same `signAndSendTransaction` underneath.
 */
export async function sendOnMainnet(input: {
  transaction: Transaction;
  connection: Connection;
  payer: string;
  adapterSend: AdapterSend;
  standard?: {
    account: unknown;
    signAndSendTransaction: (options: {
      account: unknown;
      transaction: Uint8Array;
      chain: string;
    }) => Promise<Array<{ signature: Uint8Array }>>;
  } | null;
  encodeSignature: (bytes: Uint8Array) => string;
}): Promise<string> {
  requireSingleSigner(input.transaction, input.payer);

  if (input.standard) {
    const [result] = await input.standard.signAndSendTransaction({
      account: input.standard.account,
      transaction: input.transaction.serialize({
        requireAllSignatures: false,
        verifySignatures: false,
      }),
      chain: MAINNET_CHAIN,
    });
    return input.encodeSignature(result.signature);
  }

  return input.adapterSend(input.transaction, input.connection, {
    preflightCommitment: "confirmed",
  });
}

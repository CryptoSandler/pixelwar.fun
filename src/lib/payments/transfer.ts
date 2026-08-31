import { PublicKey, SystemProgram, Transaction } from "@solana/web3.js";
import type { Connection } from "@solana/web3.js";

/**
 * The payer's side of a payment: the native SOL transfer a browser builds, a
 * wallet signs, and `sol-transfer.ts` later verifies.
 *
 * THE SPL SIDE OF THIS FILE IS GONE. It built a USDC `transferChecked`, an
 * idempotent associated-account creation, and the byte layouts of both by
 * hand rather than taking a dependency for eighty bytes of encoding. All of
 * it was correct, tested, and had no caller from the moment admission moved
 * to SOL — see DECISIONES.md.
 *
 * What survives is the thing that made the old file worth its own module:
 * the reference account. A transfer with the reference missing, or carried
 * with the wrong flags, looks and behaves exactly like a correct one right up
 * until a payer closes their tab and `recover.ts` cannot find their money. So
 * it is attached by a function a test can pull apart key by key.
 */

export type BuildResult =
  | { ok: true; transaction: Transaction }
  | { ok: false; message: string };

/**
 * The registration fee: lamports, straight from the payer to the receiving
 * wallet.
 *
 * A NATIVE TRANSFER AND NOT A TOKEN ONE, so none of the machinery above
 * applies — no associated accounts to derive, none to create, no mint to
 * check. `SystemProgram.transfer` from web3.js rather than the hand-written
 * layout the SPL instructions needed, because there is no dependency to save
 * here: web3.js is already what builds and sends every transaction on this
 * screen.
 *
 * THE REFERENCE IS OPTIONAL, and which caller passes it is the difference
 * between the two payments this function now builds.
 *
 * An ADMISSION has to be findable later by a recovery pass that knows only
 * the order, so it passes one. A REGISTRATION does not have an order: it is
 * claimed by the payer handing us the signature, and if they never do,
 * `registrations` simply has no row — the wallet can pay again another day,
 * and the only thing lost is a fee somebody paid and did not claim. That case
 * is filed by hand, it is why the fee is small, and giving registrations a
 * reference of their own is recorded in docs/operations.md as the improvement
 * that would end it.
 */
export async function buildSolTransfer(
  connection: Connection,
  params: {
    payer: PublicKey;
    recipient: PublicKey;
    lamports: bigint;
    /**
     * The order's Solana Pay reference, for an ADMISSION payment. Omitted for
     * a painter's registration, which has no order to be found by — see the
     * paragraph below.
     */
    reference?: PublicKey;
  },
): Promise<BuildResult> {
  const instruction = SystemProgram.transfer({
    fromPubkey: params.payer,
    toPubkey: params.recipient,
    lamports: params.lamports,
  });

  /**
   * The reference rides along as a read-only, non-signing account.
   *
   * The System Program takes the accounts it needs positionally and ignores
   * the rest, which is what makes this legal and is how Solana Pay attaches a
   * reference to a native transfer. It changes nothing about what moves; it
   * exists so `getSignaturesForAddress(reference)` can find this transaction
   * later, which is the whole recovery story for a payer who signs and closes
   * the tab.
   *
   * Pushed onto the instruction's keys AFTER it is built, deliberately: the
   * two accounts the program actually reads must keep their positions, and
   * appending is the only way to add one without disturbing them.
   */
  if (params.reference) {
    instruction.keys.push({ pubkey: params.reference, isSigner: false, isWritable: false });
  }

  const transaction = new Transaction().add(instruction);
  transaction.feePayer = params.payer;

  try {
    const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash("confirmed");
    transaction.recentBlockhash = blockhash;
    transaction.lastValidBlockHeight = lastValidBlockHeight;
  } catch {
    return { ok: false, message: "The Solana network did not answer. Try again in a moment." };
  }

  return { ok: true, transaction };
}

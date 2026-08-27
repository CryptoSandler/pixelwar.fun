import { PublicKey, SystemProgram, Transaction, TransactionInstruction } from "@solana/web3.js";
import type { Connection } from "@solana/web3.js";

/**
 * The payer's side of a payment: the USDC transfer a browser builds, a wallet
 * signs, and `solana.ts` later verifies.
 *
 * Deliberately its own module rather than code inside the component that
 * sends it. The one thing here that cannot be checked by looking at the
 * screen is the reference account — a transfer with the reference missing,
 * or carried with the wrong flags, looks and behaves exactly like a correct
 * one right up until a payer closes their tab and the recovery pass in
 * `recover.ts` cannot find their money. So the instruction is built by a
 * pure function that a test can pull apart key by key.
 *
 * No `@solana/spl-token` dependency: the two instructions this needs are a
 * fixed byte layout each, and both are written out below. Adding a package
 * for eighty bytes of encoding would be a bigger commitment than the code it
 * replaces.
 */

/** The SPL Token program. Mainnet USDC is a classic Token program mint, not Token-2022. */
export const TOKEN_PROGRAM_ID = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");

export const ASSOCIATED_TOKEN_PROGRAM_ID = new PublicKey(
  "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL",
);

const SYSTEM_PROGRAM_ID = new PublicKey("11111111111111111111111111111111");

/** SPL Token instruction discriminator for `TransferChecked`. */
const TRANSFER_CHECKED = 12;

/**
 * Associated Token Account program discriminator for `CreateIdempotent`.
 *
 * Idempotent rather than plain `Create` (0): two payers can pay within the
 * same block, and the plain instruction fails the whole transaction if the
 * account it would create already exists. Idempotent succeeds either way,
 * which is what a payment wants — the account existing is the goal, not the
 * creating of it.
 */
const CREATE_IDEMPOTENT = 1;

/** The associated token account for `owner` and `mint`. */
export function associatedTokenAddress(owner: PublicKey, mint: PublicKey): PublicKey {
  const [address] = PublicKey.findProgramAddressSync(
    [owner.toBuffer(), TOKEN_PROGRAM_ID.toBuffer(), mint.toBuffer()],
    ASSOCIATED_TOKEN_PROGRAM_ID,
  );
  return address;
}

function u64le(value: bigint): Uint8Array {
  const bytes = new Uint8Array(8);
  new DataView(bytes.buffer).setBigUint64(0, value, true);
  return bytes;
}

export type TransferParams = {
  /** The connected wallet: source owner, fee payer, and the only signer. */
  payer: PublicKey;
  /** The receiving wallet's OWNER address, not its token account. */
  recipient: PublicKey;
  mint: PublicKey;
  decimals: number;
  amountBaseUnits: bigint;
  /**
   * The order's Solana Pay reference. Rides along as a read-only, non-signing
   * account so `getSignaturesForAddress(reference)` finds this transaction
   * later. It is referenced by no program and changes nothing about what the
   * transfer does.
   */
  reference: PublicKey;
};

/**
 * The transfer itself, with the reference attached.
 *
 * `TransferChecked` rather than `Transfer` because it carries the mint and
 * the decimals, so a wallet can show the payer what is actually moving and a
 * mismatched decimal count fails on-chain instead of moving the wrong sum.
 * The verifier reads balance deltas and accepts either, so this choice is
 * for the payer's benefit, not ours.
 */
export function transferCheckedInstruction(params: TransferParams): TransactionInstruction {
  const source = associatedTokenAddress(params.payer, params.mint);
  const destination = associatedTokenAddress(params.recipient, params.mint);

  const data = new Uint8Array(10);
  data[0] = TRANSFER_CHECKED;
  data.set(u64le(params.amountBaseUnits), 1);
  data[9] = params.decimals;

  return new TransactionInstruction({
    programId: TOKEN_PROGRAM_ID,
    keys: [
      { pubkey: source, isSigner: false, isWritable: true },
      { pubkey: params.mint, isSigner: false, isWritable: false },
      { pubkey: destination, isSigner: false, isWritable: true },
      { pubkey: params.payer, isSigner: true, isWritable: false },
      // The reference. Not a signer — nobody holds its private half, this
      // project least of all; it was generated and discarded unread by
      // `POST /api/orders`. Not writable — it is an address, not an account
      // this transaction touches. Both flags matter: a signer flag would
      // make the transaction unsignable, and a writable flag would claim a
      // write lock on an account for no reason.
      { pubkey: params.reference, isSigner: false, isWritable: false },
    ],
    data: Buffer.from(data),
  });
}

/**
 * Opens the recipient's USDC account when it does not exist yet, paid for by
 * the payer.
 *
 * Rare in practice — the receiving wallet holds USDC from the first payment
 * onward — but a first payer whose transfer failed for this reason would
 * have no way to tell what went wrong.
 */
export function createRecipientAccountInstruction(params: {
  payer: PublicKey;
  recipient: PublicKey;
  mint: PublicKey;
}): TransactionInstruction {
  return new TransactionInstruction({
    programId: ASSOCIATED_TOKEN_PROGRAM_ID,
    keys: [
      { pubkey: params.payer, isSigner: true, isWritable: true },
      {
        pubkey: associatedTokenAddress(params.recipient, params.mint),
        isSigner: false,
        isWritable: true,
      },
      { pubkey: params.recipient, isSigner: false, isWritable: false },
      { pubkey: params.mint, isSigner: false, isWritable: false },
      { pubkey: SYSTEM_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
    ],
    data: Buffer.from([CREATE_IDEMPOTENT]),
  });
}

export type BuildResult =
  | { ok: true; transaction: Transaction }
  | { ok: false; message: string };

/**
 * The whole unsigned transaction, ready for a wallet.
 *
 * Two account lookups before anything is built, and both exist to fail with
 * something a payer can act on rather than with a wallet's simulation error:
 * a payer holding no USDC at all has no source account, and a receiving
 * wallet that has never held USDC has no destination account.
 */
export async function buildPaymentTransaction(
  connection: Connection,
  params: TransferParams,
): Promise<BuildResult> {
  const source = associatedTokenAddress(params.payer, params.mint);
  const destination = associatedTokenAddress(params.recipient, params.mint);

  let sourceInfo, destinationInfo;
  try {
    [sourceInfo, destinationInfo] = await Promise.all([
      connection.getAccountInfo(source),
      connection.getAccountInfo(destination),
    ]);
  } catch {
    return { ok: false, message: "The Solana network did not answer. Try again in a moment." };
  }

  if (!sourceInfo) {
    return {
      ok: false,
      message: "This wallet holds no USDC on Solana. Fund it and try again.",
    };
  }

  const transaction = new Transaction();
  if (!destinationInfo) {
    transaction.add(createRecipientAccountInstruction(params));
  }
  transaction.add(transferCheckedInstruction(params));
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
 * NO REFERENCE ACCOUNT, which is the real difference from a checkout. An
 * entry payment has to be findable later by a recovery pass that only knows
 * the order — hence the reference key. A registration is claimed by the payer
 * handing us the signature, and if they never do, `registrations` simply has
 * no row: the wallet can pay again another day, and the only thing lost is
 * a fee somebody paid and did not claim. That case is filed by hand like any
 * other unmatched payment, and it is the reason the fee is small.
 */
export async function buildSolTransfer(
  connection: Connection,
  params: { payer: PublicKey; recipient: PublicKey; lamports: bigint },
): Promise<BuildResult> {
  const transaction = new Transaction().add(
    SystemProgram.transfer({
      fromPubkey: params.payer,
      toPubkey: params.recipient,
      lamports: params.lamports,
    }),
  );
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

import { base58Decode } from "../base58";

/**
 * What a Solana transaction signature looks like, checked without a network.
 *
 * Its own module — split out of `solana.ts`, which is the only other place
 * this ever lived — because the browser needs the same answer and `solana.ts`
 * cannot cross: it imports `config.ts`, which reads `process.env`, and pulling
 * that into a client bundle to borrow one predicate would be a poor trade.
 *
 * The alternative was a second copy of the check in the component, and
 * `base58.ts`'s own header records what happened the last time this codebase
 * had two copies of a decoder: they drifted inside a single batch, one
 * rejecting empty input and the other not. So there is one copy, here, and
 * both the route's verifier and the paste form import it.
 */

/** A signature is 64 bytes, which is 87 or 88 base58 characters. */
export const SIGNATURE_BYTES = 64;

/**
 * Whether `signature` could possibly be a signature.
 *
 * Cheap, exact, and worth running in the browser before anything is posted:
 * `POST /api/orders/[id]/confirm` records a verification attempt *before* it
 * decodes, so a typo that is obviously not base58 still spends one of the ten
 * an order gets in ten minutes. Shape is the one thing a client can rule out
 * on its own without guessing at anything the server owns.
 */
export function isSignatureShaped(signature: string): boolean {
  const decoded = base58Decode(signature.trim());
  return decoded !== null && decoded.length === SIGNATURE_BYTES;
}

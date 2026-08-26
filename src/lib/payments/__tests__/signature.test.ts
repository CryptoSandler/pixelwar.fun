/**
 * The shape check, which is now load-bearing in two places.
 *
 * It has always guarded `verifyPayment`. What is new is that the paste form
 * in the browser runs the same predicate before it posts, so that a typo
 * costs nothing: `POST /api/orders/[id]/confirm` records a verification
 * attempt *before* it decodes, and an order gets ten in ten minutes. If these
 * two answers ever disagree the form either spends attempts on strings the
 * server was always going to reject, or refuses signatures the server would
 * have accepted — so the predicate is one function with its own cases rather
 * than a habit repeated twice.
 *
 * No database, so no per-test timeout is needed.
 */

import { describe, expect, it } from "vitest";
import { base58Encode } from "../../base58";
import { SIGNATURE_BYTES, isSignatureShaped } from "../signature";

/** A signature-shaped string: `n` bytes, base58, deterministic. */
function bytes(n: number, seed = 7): string {
  const out = new Uint8Array(n);
  for (let i = 0; i < n; i++) out[i] = (i * 37 + seed) % 256;
  return base58Encode(out);
}

describe("what a Solana signature looks like", () => {
  it("accepts 64 bytes of base58", () => {
    const signature = bytes(SIGNATURE_BYTES);
    expect(signature.length).toBeGreaterThanOrEqual(87);
    expect(signature.length).toBeLessThanOrEqual(88);
    expect(isSignatureShaped(signature)).toBe(true);
  });

  it("accepts one whose leading zero bytes make it shorter than 87 characters", () => {
    // A signature that happens to start with zero bytes encodes to leading
    // '1's and can be any length. Rejecting on character count instead of
    // decoded length would turn a rare but perfectly valid signature into a
    // signature the payer is told to retype, forever.
    const raw = new Uint8Array(SIGNATURE_BYTES);
    raw.set([0, 0, 0, 0], 0);
    for (let i = 4; i < SIGNATURE_BYTES; i++) raw[i] = (i * 11) % 256;
    expect(isSignatureShaped(base58Encode(raw))).toBe(true);
  });

  it("ignores surrounding whitespace, because a paste carries it", () => {
    expect(isSignatureShaped(`  ${bytes(SIGNATURE_BYTES)}\n`)).toBe(true);
  });

  it("rejects a wallet address — the paste mistake this actually catches", () => {
    // 32 bytes, valid base58, and the wrong thing entirely. Somebody looking
    // at a block explorer has both strings in front of them.
    expect(isSignatureShaped(bytes(32))).toBe(false);
  });

  it("rejects anything that is not 64 bytes", () => {
    for (const length of [1, 31, 33, 63, 65, 128]) {
      expect(isSignatureShaped(bytes(length)), `${length} bytes`).toBe(false);
    }
  });

  it("rejects characters outside the base58 alphabet", () => {
    const valid = bytes(SIGNATURE_BYTES);
    // 0, O, I and l are the four the alphabet leaves out precisely because
    // they are the four a person misreads.
    for (const char of ["0", "O", "I", "l", "+", "/", " "]) {
      expect(isSignatureShaped(char + valid.slice(1)), char).toBe(false);
    }
  });

  it("rejects an empty string", () => {
    expect(isSignatureShaped("")).toBe(false);
    expect(isSignatureShaped("   ")).toBe(false);
  });
});

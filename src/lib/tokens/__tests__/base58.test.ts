import { describe, expect, it } from "vitest";
import { base58Decode, base58Encode } from "../base58";

const USDC_SOL = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const WSOL = "So11111111111111111111111111111111111111112";

describe("base58", () => {
  it("round-trips a 32-byte mint", () => {
    const bytes = base58Decode(USDC_SOL)!;
    expect(bytes).toHaveLength(32);
    expect(base58Encode(bytes)).toBe(USDC_SOL);
  });

  it("preserves leading zero bytes", () => {
    const bytes = base58Decode(WSOL)!;
    expect(bytes).toHaveLength(32);
    expect(base58Encode(bytes)).toBe(WSOL);
  });

  it("rejects a character outside the alphabet", () => {
    // 0, O, I and l are all excluded from base58 specifically to avoid this
    // kind of visual confusion.
    expect(base58Decode("0OIl")).toBeNull();
  });

  // This is the exact behaviour that had drifted between the two private
  // copies this module replaces: one rejected empty input, the other did
  // not (it happened to return a one-byte zero array instead of null).
  it("rejects empty input", () => {
    expect(base58Decode("")).toBeNull();
  });
});

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { USDC_DECIMALS, USDC_MINT, formatUsdc, paymentWallet, usdToBaseUnits } from "../config";

describe("USDC amounts", () => {
  it("converts whole dollars to base units at six decimals", () => {
    expect(usdToBaseUnits(1)).toBe(1_000_000n);
    expect(usdToBaseUnits(99)).toBe(99_000_000n);
  });

  it("refuses an amount it cannot represent exactly", () => {
    // Entry prices are whole dollars. A fractional amount here means a caller
    // is inventing a price, and rounding it silently would take the wrong sum.
    expect(() => usdToBaseUnits(1.005)).toThrow();
    expect(() => usdToBaseUnits(-1)).toThrow();
    expect(() => usdToBaseUnits(Number.NaN)).toThrow();
    expect(() => usdToBaseUnits(-0)).toThrow();
    expect(() => usdToBaseUnits(Number.POSITIVE_INFINITY)).toThrow();
  });

  it("refuses an amount too large for a JS number to hold exactly", () => {
    // The guard must be Number.isSafeInteger, not Number.isInteger. Past 2^53
    // a float no longer has a neighbour: 2**60 and 2**60 + 1 are the SAME
    // value, so two different intended amounts arrive as one and neither the
    // caller nor we can tell which was meant. Refusing is the only honest
    // answer a money function has there.
    expect(() => usdToBaseUnits(2 ** 60)).toThrow();
    expect(() => usdToBaseUnits(Number.MAX_SAFE_INTEGER + 2)).toThrow();
    expect(usdToBaseUnits(Number.MAX_SAFE_INTEGER - 1)).toBeTypeOf("bigint");
  });

  it("round-trips through formatUsdc", () => {
    expect(formatUsdc(usdToBaseUnits(25))).toBe("25.00");
  });

  it("pins the mint and the decimals", () => {
    // Getting either wrong means verifying a payment in the wrong asset.
    expect(USDC_MINT).toBe("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");
    expect(USDC_DECIMALS).toBe(6);
  });
});

describe("paymentWallet", () => {
  // The suite runs single-fork: a variable one file deletes, every later
  // file inherits. Restore whatever was configured before this file ran so
  // the next test file sees it, not the absence this describe block needs.
  const originalPaymentWallet = process.env.PAYMENT_WALLET;

  beforeEach(() => {
    delete process.env.PAYMENT_WALLET;
  });

  afterEach(() => {
    if (originalPaymentWallet === undefined) {
      delete process.env.PAYMENT_WALLET;
    } else {
      process.env.PAYMENT_WALLET = originalPaymentWallet;
    }
  });

  it("refuses to take payments when no wallet is configured", () => {
    // A fallback here would mean a misconfigured deploy quietly collects
    // payments to somebody else's address.
    expect(paymentWallet().ok).toBe(false);
  });

  it("rejects a value that is not a Solana address", () => {
    process.env.PAYMENT_WALLET = "not-an-address";
    expect(paymentWallet().ok).toBe(false);
  });

  it("accepts a well-formed address", () => {
    process.env.PAYMENT_WALLET = "7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU";
    expect(paymentWallet()).toMatchObject({ ok: true });
  });
});

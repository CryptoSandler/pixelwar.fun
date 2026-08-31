import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  formatSol,
  paymentWallet,
  registrationFeeLamports,
  registrationIsFree,
} from "../config";

describe("SOL amounts", () => {
  /**
   * `formatSol` replaced `formatUsdc` when admission moved to SOL, and its
   * job is the same: turn the smallest unit into something a person reads
   * next to a wallet dialog. The USDC helpers this file used to test —
   * `usdToBaseUnits`, `formatUsdc`, and the mint constants — went with the
   * verifier that used them. See DECISIONES.md.
   */
  it("reads like a price, never like a float", () => {
    expect(formatSol(3_000_000n)).toBe("0.003");
    expect(formatSol(10_000_000n)).toBe("0.01");
    expect(formatSol(1_000_000_000n)).toBe("1.00");
    // Two decimals is a floor, not a ceiling: "1.50" reads as a price where
    // "1.5" reads as a float somebody forgot to format.
    expect(formatSol(1_500_000_000n)).toBe("1.50");
    expect(formatSol(0n)).toBe("0.00");
  });

  it("keeps every lamport rather than rounding to something tidier", () => {
    // This quotes what a wallet is about to be asked for. A rounded quote
    // beside an unrounded wallet dialog is a disagreement a payer notices.
    expect(formatSol(1_234_567_891n)).toBe("1.234567891");
    expect(formatSol(1n)).toBe("0.000000001");
  });

  it("carries the fee's default and its off switch", () => {
    delete process.env.REGISTRATION_FEE_SOL;
    expect(registrationFeeLamports()).toBe(3_000_000n);
    expect(registrationIsFree()).toBe(false);

    process.env.REGISTRATION_FEE_SOL = "0";
    expect(registrationFeeLamports()).toBe(0n);
    expect(registrationIsFree()).toBe(true);

    // A typo must not switch the fee off quietly, and must not raise it.
    process.env.REGISTRATION_FEE_SOL = "not-a-number";
    expect(registrationFeeLamports()).toBe(3_000_000n);
    delete process.env.REGISTRATION_FEE_SOL;
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

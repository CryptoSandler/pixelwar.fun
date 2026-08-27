import { describe, expect, it } from "vitest";
import {
  checkoutOutcome,
  isRetryableConfirmReason,
  PAYMENTS_UNCONFIGURED_MESSAGE,
  walletErrorMessage,
} from "../checkout";

/**
 * The money path's decisions, which had no test at all until now.
 *
 * `PayWithWallet` is 584 lines, handles a wallet adapter, a retry loop and
 * four phases, and every one of the judgements below happens at a moment
 * where being wrong costs somebody real money. None of them needed a browser
 * to be wrong in, and none of them needs one to be tested.
 */

describe("which /confirm failures are worth retrying", () => {
  it("retries only the reasons that can change on their own", () => {
    // The chain catching up, a block time not published yet, an RPC that
    // blinked. All three are true now and false in five seconds.
    expect(isRetryableConfirmReason("not_confirmed")).toBe(true);
    expect(isRetryableConfirmReason("no_block_time")).toBe(true);
    expect(isRetryableConfirmReason("rpc_unavailable")).toBe(true);
  });

  it("does not retry a verdict that will be identical in five seconds", () => {
    // Each attempt spends the order's verification quota (VERIFY_LIMITS caps
    // attempts per order AND per caller), so hammering a permanent failure
    // burns the budget the payer needs for the attempt that would work.
    for (const reason of [
      "wrong_payer",
      "insufficient_amount",
      "outside_bid_window",
      "signature_reused",
      "already_settled",
      "unmatched",
    ]) {
      expect(isRetryableConfirmReason(reason), reason).toBe(false);
    }
  });

  it("does not retry a reason it has never heard of", () => {
    // Fails closed. A new reason added server-side is not retryable until
    // somebody decides it is, rather than being retried by default because
    // it fell through a condition.
    expect(isRetryableConfirmReason("something_new")).toBe(false);
    expect(isRetryableConfirmReason(undefined)).toBe(false);
    expect(isRetryableConfirmReason(null)).toBe(false);
    expect(isRetryableConfirmReason(42)).toBe(false);
  });
});

describe("telling a settled payer from a refunded one", () => {
  it("says paid when a reused signature belongs to an order that is paid", () => {
    // The benign case: a dropped response to a /confirm that actually
    // settled, so the retry posted a signature the server had already spent.
    // That payer's money IS accounted for.
    expect(
      checkoutOutcome({
        failure: { reason: "signature_reused", message: "That signature is spent." },
        orderStatus: "paid",
      }),
    ).toEqual({ kind: "paid" });
  });

  it("NEVER says paid on already_settled, even though the order reads paid", () => {
    // THE DANGEROUS ONE, and the reason this is not written as "any failure
    // on a paid order". `already_settled` means the order was paid by a
    // DIFFERENT payment; this payer's money is real, unmatched, and filed for
    // support. The order does read `paid` — by somebody else's money — so
    // treating a paid status as success here would congratulate a payer who
    // is owed a refund and bury the only message that tells them so.
    const outcome = checkoutOutcome({
      failure: {
        reason: "already_settled",
        message: "Your payment has been filed for manual review.",
      },
      orderStatus: "paid",
    });

    expect(outcome.kind).toBe("error");
    expect(outcome).toMatchObject({ message: "Your payment has been filed for manual review." });
  });

  it("does not say paid on a reused signature when the order is not paid", () => {
    // Somebody else claimed that signature. This payer has not been credited
    // and must not be told they have.
    for (const status of ["pending", "expired", "failed", null]) {
      expect(
        checkoutOutcome({
          failure: { reason: "signature_reused", message: "That signature is spent." },
          orderStatus: status,
        }).kind,
        String(status),
      ).toBe("error");
    }
  });

  it("treats an unreadable status as not-paid rather than as paid", () => {
    // `orderStatus()` never throws and returns null on a network blip, so a
    // blip must read as "cannot tell", never as "settled".
    expect(
      checkoutOutcome({
        failure: { reason: "signature_reused", message: "spent" },
        orderStatus: null,
      }).kind,
    ).toBe("error");
  });

  it("keeps an ordinary failure's own message", () => {
    expect(
      checkoutOutcome({
        failure: { reason: "insufficient_amount", message: "That paid 24.00 of 25.00." },
        orderStatus: "pending",
      }),
    ).toEqual({ kind: "error", message: "That paid 24.00 of 25.00." });
  });
});

describe("a wallet's failure, as a sentence", () => {
  it("names the dismissal rather than quoting the adapter", () => {
    expect(walletErrorMessage(new Error("User rejected the request."))).toBe(
      "You dismissed the payment in your wallet.",
    );
    expect(walletErrorMessage(new Error("Transaction cancelled"))).toMatch(/dismissed/);
  });

  it("turns a preflight failure into something a payer can act on", () => {
    // What an underfunded payer actually gets back is "Transaction simulation
    // failed: Error processing Instruction 1: custom program error: 0x1",
    // which DESIGN.md §8 rules out putting on screen.
    const message = walletErrorMessage(
      new Error("Transaction simulation failed: custom program error: 0x1"),
    );
    expect(message).toMatch(/USDC/);
    expect(message).not.toMatch(/0x1|simulation|Instruction/);
  });

  it("never puts a developer string on screen, whatever arrives", () => {
    for (const thrown of [null, undefined, 42, { code: -32003 }, "RPC error -32603"]) {
      const message = walletErrorMessage(thrown);
      expect(message.length).toBeGreaterThan(0);
      expect(message).not.toMatch(/-32\d{3}|\[object/);
    }
  });
});

describe("the deployment that cannot take money yet", () => {
  it("does not blame the visitor, promise a time, or name the variable", () => {
    // PAYMENT_WALLET unset is a configuration fault, not the payer's. The
    // missing variable belongs in the server log, where paymentWallet()
    // already puts it — not on a stranger's screen.
    expect(PAYMENTS_UNCONFIGURED_MESSAGE).not.toMatch(/PAYMENT_WALLET|env|config/i);
    expect(PAYMENTS_UNCONFIGURED_MESSAGE).not.toMatch(/soon|shortly|minutes|hours/i);
    // And it says the thing that is actually true and useful: nothing was
    // charged, and the board still works.
    expect(PAYMENTS_UNCONFIGURED_MESSAGE).toMatch(/[Nn]othing has been charged/);
    expect(PAYMENTS_UNCONFIGURED_MESSAGE).toMatch(/paint/);
  });
});

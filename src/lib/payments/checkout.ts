/**
 * The decisions the payment screen makes, taken out of the payment screen.
 *
 * ITS OWN MODULE FOR THE REASON `cluster.ts` GIVES: a component that owns a
 * wallet adapter, a retry loop and four phases of local state cannot be
 * asserted about from Node, and these functions can. Everything here is a
 * pure answer to a question the checkout asks at a moment where being wrong
 * costs somebody real money — so it belongs where a test can reach it rather
 * than inside a 584-line component that only a browser can run.
 *
 * Deliberately no testing-library and no jsdom. Rendering the component would
 * test React; what needs testing is the reasoning, and the reasoning is here.
 */

/**
 * Whether a failed `/confirm` is worth trying again.
 *
 * Only reasons that can change on their own. A wrong amount or a wrong payer
 * will still be wrong in five seconds, and every attempt spends the order's
 * verification quota — `VERIFY_LIMITS` caps attempts per order and per
 * caller, so a retry loop that hammers a permanent failure burns the budget
 * the payer needs for the attempt that would have worked.
 */
export function isRetryableConfirmReason(reason: unknown): boolean {
  return reason === "not_confirmed" || reason === "no_block_time" || reason === "rpc_unavailable";
}

export type ConfirmFailure = { reason?: string; message: string };

export type CheckoutOutcome =
  | { kind: "paid" }
  | { kind: "error"; message: string };

/**
 * What to show a payer whose `/confirm` came back a failure.
 *
 * THE ONE MESSAGE THIS FLOW MUST NEVER PRODUCE is "your payment failed" to
 * somebody whose payment succeeded, and there are two different failures that
 * both look like it from the client. Telling them apart is this function's
 * whole job.
 *
 * `signature_reused` means the server has already claimed this signature.
 * The usual cause is benign: a dropped response to a `/confirm` that actually
 * settled, so the retry posted a signature the server had already spent. If
 * the order reads `paid`, that payer's money IS accounted for and the screen
 * should say so.
 *
 * `already_settled` looks identical and must NOT take that path. It means the
 * order was paid by a DIFFERENT payment and this one is real, unmatched, and
 * filed for support. The order does read `paid` — by somebody else's money —
 * so a status check would "confirm" success for a payer who is owed a refund
 * and bury the only message that tells them so.
 *
 * Anything else is an ordinary failure and keeps its own message.
 */
export function checkoutOutcome(input: {
  failure: ConfirmFailure;
  /** The order's own status, as `GET /api/orders/[id]` reports it. */
  orderStatus: string | null;
}): CheckoutOutcome {
  const { failure, orderStatus } = input;

  if (failure.reason === "signature_reused" && orderStatus === "paid") {
    return { kind: "paid" };
  }

  return { kind: "error", message: failure.message };
}

/**
 * A wallet's own failure, as a sentence.
 *
 * Wallet errors are developer strings — `Transaction simulation failed: Error
 * processing Instruction 1: custom program error: 0x1` is what an underfunded
 * payer gets from a preflight — and DESIGN.md §8 rules that out. The detail
 * still goes to the console, where it is useful; it just does not go on
 * screen as the explanation.
 */
export function walletErrorMessage(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error ?? "");
  if (/reject|denied|cancel/i.test(raw)) return "You dismissed the payment in your wallet.";
  if (/insufficient|0x1\b/i.test(raw)) {
    return "The payment did not go through. Check the wallet holds enough SOL, including a little for the network fee.";
  }
  return "Your wallet could not send this payment. Try again in a moment.";
}

/**
 * What a payer is told when this deployment cannot take money at all.
 *
 * `PAYMENT_WALLET` unset is a configuration fault, not the payer's, and the
 * generic "payments are not available" the routes return says nothing about
 * what to do. This is the sentence the entry screens use instead: it does not
 * blame the visitor, does not promise a time, and does not leak which
 * environment variable is missing — that detail is in the server log, where
 * `paymentWallet()` already puts it.
 */
export const PAYMENTS_UNCONFIGURED_MESSAGE =
  "Entries are not open yet. Nothing has been charged, and the board is free to paint on in the meantime.";

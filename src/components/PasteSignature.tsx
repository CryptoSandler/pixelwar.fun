"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { orderStatus } from "../lib/payments/order-status";
import { isSignatureShaped } from "../lib/payments/signature";
import { shortenAddress } from "../lib/tokens/addresses";

/**
 * The way in for a payer whose wallet cannot reach this browser.
 *
 * A phone wallet that opened its own in-app browser, a hardware wallet driven
 * from a desktop app, a withdrawal from an exchange — in every one of those
 * the SOL moves and no wallet ever connects here, so the flow on this page
 * above has nothing to sign with and no signature to post. The transfer is
 * real either way; what is missing is only the string that identifies it. So
 * the string can be typed.
 *
 * **Nothing here moves money.** This form checks a payment that has already
 * been made against this order, on the same server path and with the same
 * verifier the wallet flow uses. It cannot create a payment and it cannot
 * approve one, which is why it needs no network disclosure and no block: no
 * signature is produced on this screen.
 *
 * Collapsed by default. It is the exception, and putting it in front of
 * everyone who does have a wallet would invite people to go looking for a
 * signature they do not need.
 */

type State =
  | { kind: "idle" }
  | { kind: "checking" }
  | { kind: "paid" }
  | { kind: "error"; message: string };

/**
 * What a signature looks like, said in the copy rather than left to the
 * error. 64 bytes of base58 is 87 or 88 characters; the check itself is
 * `isSignatureShaped`, shared with the server's verifier.
 */
const SHAPE_HINT = "87 or 88 characters of letters and digits";

export function PasteSignature({
  orderId,
  /**
   * The wallet this order named when it was started, or null if it named
   * none. It decides which of two very different sentences goes next to the
   * input, and getting it wrong would cost somebody a payment: an order that
   * names a wallet cannot be settled by a transfer from anywhere else, which
   * is precisely the case a hardware wallet or an exchange is in.
   */
  payerPubkey,
}: {
  orderId: string;
  payerPubkey: string | null;
}) {
  const router = useRouter();
  const [signature, setSignature] = useState("");
  const [state, setState] = useState<State>({ kind: "idle" });

  async function check() {
    const trimmed = signature.trim();

    // Shape first, and in the browser, because a verification attempt is a
    // scarce thing: `POST /api/orders/[id]/confirm` records one BEFORE it
    // decodes anything, so a mistyped signature spends one of the ten an
    // order gets in ten minutes and then comes back "that is not a
    // signature". The same predicate the server uses, imported rather than
    // written twice, so the two answers cannot drift.
    if (!isSignatureShaped(trimmed)) {
      setState({
        kind: "error",
        message:
          `That is not a transaction signature — it should be ${SHAPE_HINT}. ` +
          "Nothing was sent, so this did not use up one of the checks.",
      });
      return;
    }

    setState({ kind: "checking" });
    let response: Response;
    try {
      response = await fetch(`/api/orders/${orderId}/confirm`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ signature: trimmed }),
      });
    } catch {
      setState({
        kind: "error",
        message: "The check did not come back. Try again in a moment — nothing was charged.",
      });
      return;
    }

    const body = await response.json().catch(() => ({}));
    if (response.ok) {
      setState({ kind: "paid" });
      // The server component holds the order's status, so it is the one that
      // has to be asked again. `force-dynamic` on this route means a refresh
      // really does re-read the row.
      router.refresh();
      return;
    }

    // `signature_reused`, and only that reason — the same case the wallet flow
    // handles for the same reason. A dropped response to a check that actually
    // settled makes the retry post a signature the server has already claimed,
    // and "this signature is spent" would be shown to the person whose payment
    // succeeded. Asking the order settles it and costs one request.
    //
    // `already_settled` deliberately does NOT come here: it means the order was
    // paid by somebody else's transfer and this one is real, unmatched and
    // filed for support. The order does read `paid` then — by other money — so
    // treating it as success would bury the only message that tells this payer
    // they are owed something.
    if (body?.reason === "signature_reused" && (await orderStatus(orderId)) === "paid") {
      setState({ kind: "paid" });
      router.refresh();
      return;
    }

    setState({
      kind: "error",
      message: typeof body?.error === "string" ? body.error : "That payment could not be checked.",
    });
  }

  if (state.kind === "paid") {
    return (
      <section className="panel bevel flex flex-col gap-2 p-4">
        <h2 className="section-label">Payment found</h2>
        <p className="text-[13px]">
          That transfer is credited to this order. The page is catching up now.
        </p>
      </section>
    );
  }

  return (
    <>
      <details className="panel bevel p-4">
        <summary className="section-label cursor-pointer">Paid from another wallet?</summary>

        <div className="mt-3 flex flex-col gap-3">
          <p className="muted text-[13px]">
            If the SOL was sent from a phone, a hardware wallet or an exchange, no wallet ever
            reaches this page — but the transfer is still on Solana. Paste its transaction signature
            and it is checked against this order. Nothing is sent or signed from here.
          </p>

          {/* Full-strength ink, not the muted footnote colour: this is the one
              fact on the screen that decides whether a transfer from somewhere
              else can be credited at all, and it is different for the two kinds
              of order. Somebody about to send money from an exchange is entitled
              to read it before they do. */}
          {payerPubkey ? (
            <p className="text-[13px]">
              This order was started from{" "}
              <span className="numeric">{shortenAddress(payerPubkey, 6, 6)}</span>, and only that
              wallet can pay it. A transfer sent from anywhere else cannot be credited here — start a
              new order without connecting a wallet if you need to pay from elsewhere.
            </p>
          ) : (
            <p className="text-[13px]">
              No wallet is connected to this order, so it is first-to-claim: whichever matching
              payment arrives first while the window is open takes the colour, whoever sent it. Your
              transfer is not held for you until it is checked here.
            </p>
          )}

          <label className="section-label" htmlFor="signature">
            Transaction signature
          </label>
          <input
            id="signature"
            className="field w-full px-2 py-2"
            value={signature}
            spellCheck={false}
            autoComplete="off"
            placeholder={SHAPE_HINT}
            onChange={(event) => {
              setSignature(event.target.value);
              if (state.kind === "error") setState({ kind: "idle" });
            }}
          />

          <button
            type="button"
            className="btn-secondary self-start px-4 py-2"
            disabled={state.kind === "checking" || signature.trim() === ""}
            onClick={() => void check()}
          >
            {state.kind === "checking" ? "Checking…" : "Check this payment"}
          </button>
        </div>
      </details>

    {/* Outside the disclosure, deliberately. A collapsed `<details>` hides its
        children with `display: none`, and a hidden `role="alert"` announces
        nothing and a hidden `aria-live` region says nothing — so an error
        raised and then collapsed away, or raised while collapsed, reached
        nobody at all: no text on screen and no announcement either. The
        success path never had this problem because it replaces the
        `<details>` outright, and this is the same treatment. It also means a
        failed check stays visible if somebody folds the panel away while it
        is running. */}
    {state.kind === "error" ? (
      <p role="alert" className="panel bevel-in p-3 text-[13px]">
        {state.message}
      </p>
    ) : null}

    <p className="sr-only" aria-live="polite">
      {state.kind === "checking" ? "Looking the transfer up on Solana…" : null}
    </p>
    </>
  );
}

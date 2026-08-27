"use client";

import { useWallet } from "@solana/wallet-adapter-react";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { base58Encode } from "../lib/base58";

/**
 * Swearing: proving a wallet holds the token you fight for.
 *
 * WHO CALLS `POST /api/allegiance/nonce` and `POST /api/allegiance/swear`:
 * this component, and nothing else.
 *
 * THE ORDER OF THE THREE STEPS IS THE DESIGN. The nonce is fetched at the
 * moment the button is pressed, never on mount — it lives five minutes, and
 * fetching one on page load spends most of that before anybody decides. The
 * wallet then signs the exact bytes the server stored, and the server checks
 * against its own copy, so a client that alters the message only fails its
 * own oath.
 *
 * WHAT IT DOES NOT PROMISE. Nothing here says permanent, irrevocable, or
 * forever. The sanctioned wording for the whole allegiance mechanic is "you
 * fight for one token this war", and the badge this earns is a fact about
 * holdings at the moment of the oath — see docs/operations.md, where
 * re-verification is recorded as an open decision rather than implied by
 * silence.
 */
export function SwearOath({
  warSlug,
  warTokenId,
  ticker,
  alreadySworn,
}: {
  warSlug: string;
  warTokenId: string | null;
  ticker: string | null;
  alreadySworn: boolean;
}) {
  const router = useRouter();
  const { publicKey, signMessage, connected } = useWallet();
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  if (alreadySworn) {
    return (
      <p className="muted text-[12px]">
        ✦ Sworn{ticker ? ` to ${ticker}` : ""} for this war.
      </p>
    );
  }

  if (!warTokenId) {
    return (
      <p className="muted text-[12px]">
        Paint a pixel to pick your side, then swear with a wallet that holds it.
      </p>
    );
  }

  // `signMessage` is optional on the adapter interface: a wallet that cannot
  // sign arbitrary bytes exists, and telling somebody to press a button that
  // cannot work is worse than telling them why.
  const canSign = connected && Boolean(publicKey) && Boolean(signMessage);

  async function swear() {
    if (!publicKey || !signMessage || !warTokenId) return;
    setBusy(true);
    setMessage(null);
    try {
      const challengeResponse = await fetch("/api/allegiance/nonce", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ warSlug, warTokenId }),
      });
      const challenge = await challengeResponse.json().catch(() => ({}));
      if (!challengeResponse.ok) {
        setMessage(typeof challenge?.error === "string" ? challenge.error : "Could not start.");
        return;
      }

      let signature: Uint8Array;
      try {
        signature = await signMessage(new TextEncoder().encode(challenge.message));
      } catch {
        // A dismissed wallet dialog is not an error worth a red box — the
        // person decided not to, which is a legitimate outcome.
        setMessage("You dismissed the signature request.");
        return;
      }

      const swornResponse = await fetch("/api/allegiance/swear", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          warSlug,
          warTokenId,
          wallet: publicKey.toBase58(),
          nonce: challenge.nonce,
          signature: base58Encode(signature),
        }),
      });
      const body = await swornResponse.json().catch(() => ({}));
      if (!swornResponse.ok) {
        setMessage(typeof body?.error === "string" ? body.error : "That did not work.");
        return;
      }

      setMessage(`Sworn${ticker ? ` to ${ticker}` : ""}.`);
      router.refresh();
    } catch {
      setMessage("That request did not come back.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-col gap-1">
      <button
        type="button"
        className="btn-secondary bevel px-3 py-1.5"
        disabled={!canSign || busy}
        onClick={() => void swear()}
      >
        {busy ? "Signing" : `Swear to ${ticker ?? "your token"}`}
      </button>
      <p className="muted text-[12px]">
        {canSign
          ? "Proves your wallet holds this token. It moves no funds."
          : "Connect a wallet that holds this token."}
      </p>
      {message ? (
        <p role="status" aria-live="polite" className="text-[12px]">
          {message}
        </p>
      ) : null}
    </div>
  );
}

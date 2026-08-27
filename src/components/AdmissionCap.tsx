"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { MAX_TOKEN_SLOT } from "../lib/wars/palette";

/**
 * One war's admission cap, as a control.
 *
 * WHO CALLS `POST /api/admin/wars/[id]/cap`: this component, and nothing
 * else. It is a client component for the same reason `AdminSignOut` is — the
 * endpoint takes JSON and a plain HTML form cannot send it — and for one
 * more: the answer carries how many tokens are currently seated, which is
 * worth putting on screen next to the number the operator just changed.
 *
 * `router.refresh()` afterwards so the list this sits in re-reads from the
 * server rather than trusting local state to match the row that was written.
 */
export function AdmissionCap({
  warId,
  title,
  current,
  seated,
}: {
  warId: string;
  title: string;
  current: number;
  seated: number;
}) {
  const router = useRouter();
  const [value, setValue] = useState(String(current));
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  const parsed = Number(value);
  const valid = Number.isInteger(parsed) && parsed >= 1 && parsed <= MAX_TOKEN_SLOT;

  return (
    <form
      className="panel bevel flex flex-col gap-2 p-3"
      onSubmit={async (event) => {
        event.preventDefault();
        if (!valid || busy) return;
        setBusy(true);
        setMessage(null);
        try {
          const response = await fetch(`/api/admin/wars/${warId}/cap`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ maxTokens: parsed }),
          });
          const body = await response.json().catch(() => ({}));
          if (!response.ok) {
            setMessage(typeof body?.error === "string" ? body.error : "That did not save.");
            return;
          }
          // Said plainly rather than refused: lowering the cap under the
          // seated count closes the door without evicting anybody, and an
          // operator doing it deliberately should see what it means.
          setMessage(
            body.seated > parsed
              ? `Saved. ${body.seated} already seated — they keep their places; no new ones open.`
              : "Saved.",
          );
          router.refresh();
        } catch {
          setMessage("That request did not come back.");
        } finally {
          setBusy(false);
        }
      }}
    >
      <h2 className="text-[15px] font-medium">{title}</h2>
      <p className="muted text-[13px]">
        <span className="numeric">{seated}</span> seated
      </p>

      <label className="flex items-center gap-2 text-[13px]">
        <span>Admission cap</span>
        <input
          type="number"
          min={1}
          max={MAX_TOKEN_SLOT}
          step={1}
          inputMode="numeric"
          value={value}
          onChange={(event) => setValue(event.target.value)}
          className="numeric w-20 px-2 py-1"
          style={{ background: "var(--chrome-readout)", border: "1px solid var(--chrome-control)" }}
        />
      </label>

      {/* The ceiling is arithmetic, not taste — one byte names a pixel's
          owner on the territory layer and 0 is reserved for unpainted — and
          past 24 the flag colours repeat. Both are consequences an operator
          setting this number deserves to read before they set it. */}
      <p className="muted text-[12px]">
        1–{MAX_TOKEN_SLOT}. Past 24, two tokens share a flag colour and are told apart by ticker.
      </p>

      <div className="flex items-center gap-3">
        <button type="submit" className="btn-primary px-3 py-1.5" disabled={!valid || busy}>
          {busy ? "Saving" : "Save"}
        </button>
        {message ? (
          <span role="status" aria-live="polite" className="text-[12px]">
            {message}
          </span>
        ) : null}
      </div>
    </form>
  );
}

"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

/**
 * The operator's clocks for one war.
 *
 * WHO CALLS `POST /api/admin/wars/[id]/clock`: this component.
 *
 * THE STATUS IS NEVER AN INPUT HERE, and that is the design rather than an
 * omission. `advanceWar` decides status from the clocks; a control that let
 * an operator set it directly would be offering them a way to contradict the
 * state machine, and the first thing anybody would do with it is create a
 * live war whose start has not arrived. "Start now" is `starts_at = now()`.
 */

/** `datetime-local` wants a value with no timezone and no seconds. */
function forInput(iso: string): string {
  const date = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

export function WarClocks({
  warId,
  status,
  startsAt,
  endsAt,
}: {
  warId: string;
  status: string;
  startsAt: string;
  endsAt: string;
}) {
  const router = useRouter();
  const [opensAt, setOpensAt] = useState(() => forInput(startsAt));
  const [closesAt, setClosesAt] = useState(() => forInput(endsAt));
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  async function move(which: "start" | "end", at: Date) {
    setBusy(true);
    setMessage(null);
    try {
      const response = await fetch(`/api/admin/wars/${warId}/clock`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ which, at: at.toISOString() }),
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) {
        setMessage(typeof body?.error === "string" ? body.error : "That did not work.");
        return;
      }
      setMessage(`Now ${body.status}.`);
      router.refresh();
    } catch {
      setMessage("That request did not come back.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="panel bevel flex flex-col gap-2 p-3">
      <h3 className="text-[15px] font-medium">Clocks</h3>

      {status === "scheduled" ? (
        <div className="flex flex-wrap items-end gap-2">
          <label className="flex flex-col text-[12px]">
            Opens
            <input
              type="datetime-local"
              className="field px-2 py-1"
              value={opensAt}
              onChange={(event) => setOpensAt(event.target.value)}
            />
          </label>
          <button
            type="button"
            className="btn-secondary bevel px-3 py-1.5"
            disabled={busy}
            onClick={() => void move("start", new Date(opensAt))}
          >
            Move opening
          </button>
          {/* Brass, because it is the action an operator comes to this panel
              to take on a scheduled war (DESIGN.md I5). */}
          <button
            type="button"
            className="btn-primary px-3 py-1.5"
            disabled={busy}
            onClick={() => void move("start", new Date())}
          >
            Start now
          </button>
        </div>
      ) : null}

      <div className="flex flex-wrap items-end gap-2">
        <label className="flex flex-col text-[12px]">
          Closes
          <input
            type="datetime-local"
            className="field px-2 py-1"
            value={closesAt}
            onChange={(event) => setClosesAt(event.target.value)}
          />
        </label>
        <button
          type="button"
          className="btn-secondary bevel px-3 py-1.5"
          disabled={busy}
          onClick={() => void move("end", new Date(closesAt))}
        >
          {status === "ended" ? "Revive until" : "Extend to"}
        </button>
      </div>

      {status === "ended" ? (
        <p className="muted text-[12px]">
          Reviving brings this war back to live. A deadline already in the past is refused — to
          stop a war now, end it.
        </p>
      ) : null}

      {message ? (
        <p role="status" aria-live="polite" className="text-[12px]">
          {message}
        </p>
      ) : null}
    </div>
  );
}

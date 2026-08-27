"use client";

import { useEffect, useState } from "react";

/**
 * The cooldown lives inside the button rather than beside it.
 *
 * One control: the reason you cannot paint and the thing you paint with are
 * the same object, so there is no second widget to look for. The interval
 * coarsens above a second because nobody is watching a 30-second countdown
 * frame by frame.
 */
export function PaintButton({
  cooldownUntil,
  disabled,
  label,
  onPaint,
}: {
  cooldownUntil: string | null;
  disabled: boolean;
  label: string;
  onPaint: () => void;
}) {
  const [remaining, setRemaining] = useState(0);
  const tickIntervalMs = remaining > 1000 ? 500 : 100;

  useEffect(() => {
    const tick = () =>
      setRemaining(cooldownUntil ? Math.max(0, Date.parse(cooldownUntil) - Date.now()) : 0);
    tick();
    if (!cooldownUntil) return;
    const timer = setInterval(tick, tickIntervalMs);
    return () => clearInterval(timer);
  }, [cooldownUntil, tickIntervalMs]);

  const waiting = remaining > 0;
  const seconds = Math.ceil(remaining / 1000);
  const text = waiting
    ? `${String(Math.floor(seconds / 60)).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`
    : label;

  return (
    <button
      type="button"
      disabled={disabled || waiting}
      onClick={onPaint}
      // THE brass key. `btn-primary` is the accent, the bevel and the zero
      // radius in one class (DESIGN.md I5, §4) — this button used to be
      // `rounded-full` with no accent at all, which is to say the one control
      // the whole screen exists to offer looked like a link.
      //
      // The disabled face is `btn-primary:disabled`'s named colour, not a
      // filter: while the cooldown runs this label IS the countdown, the one
      // thing a painter is waiting to read, and `DISABLED_FACE` carries the
      // full ink at 4.85:1 rather than compositing it to a number nobody
      // measured.
      className="btn-primary w-full px-8 py-3"
    >
      {text}
    </button>
  );
}

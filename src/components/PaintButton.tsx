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
      // Quiet, not out of reach — and the distinction decides the colour.
      // `DISABLED_INK` is right where "disabled" is the whole message, but
      // this label is not saying that: while the cooldown runs it IS the
      // countdown, which is the one thing a painter is waiting to read.
      // Hiding it at 4.14:1 to signal a state the `disabled` attribute and
      // the cursor already signal gets the trade backwards. MUTED_INK_INVERSE
      // reads 9.70:1 on the shell behind this button.
      className="rounded-full px-8 py-3 text-lg font-semibold disabled:cursor-not-allowed disabled:text-[var(--chrome-ink-muted-inverse)]"
    >
      {text}
    </button>
  );
}

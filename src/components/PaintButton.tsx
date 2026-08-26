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
      // A dead key says so with a colour, never `opacity` (DESIGN.md §9).
      // DISABLED_INK reads 4.14:1 on the shell behind this button — over
      // DISABLED_TEXT_CONTRAST, and the same named colour the secondary
      // button already uses on the light side.
      className="rounded-full px-8 py-3 text-lg font-semibold disabled:text-[var(--chrome-ink-disabled)]"
    >
      {text}
    </button>
  );
}

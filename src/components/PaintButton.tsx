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

  useEffect(() => {
    if (!cooldownUntil) {
      setRemaining(0);
      return;
    }
    const tick = () => setRemaining(Math.max(0, Date.parse(cooldownUntil) - Date.now()));
    tick();
    const timer = setInterval(tick, remaining > 1000 ? 500 : 100);
    return () => clearInterval(timer);
  }, [cooldownUntil, remaining > 1000]);

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
      className="rounded-full px-8 py-3 text-lg font-semibold disabled:opacity-60"
    >
      {text}
    </button>
  );
}

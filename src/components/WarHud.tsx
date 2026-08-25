"use client";

import { useEffect, useState } from "react";

export function WarHud({
  hovered,
  scale,
  startsAt,
  endsAt,
  notStarted,
  onStart,
}: {
  hovered: { x: number; y: number } | null;
  scale: number;
  startsAt: string;
  endsAt: string;
  notStarted: boolean;
  onStart?: () => void;
}) {
  const [remaining, setRemaining] = useState("");
  // A war that has not started counts down to its own opening, not to a clock
  // that has not begun ticking. Counting endsAt here for a scheduled war is
  // exactly the bug this HUD used to have.
  const target = notStarted ? startsAt : endsAt;

  useEffect(() => {
    const tick = () => {
      const ms = Math.max(0, Date.parse(target) - Date.now());
      const hours = Math.floor(ms / 3_600_000);
      const minutes = Math.floor((ms % 3_600_000) / 60_000);
      const seconds = Math.floor((ms % 60_000) / 1000);
      setRemaining(
        `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`,
      );
      if (ms === 0 && notStarted) onStart?.();
    };
    tick();
    const timer = setInterval(tick, 1000);
    return () => clearInterval(timer);
  }, [target, notStarted, onStart]);

  return (
    <div className="pointer-events-none flex justify-between font-mono text-sm">
      <span>{hovered ? `(${hovered.x}, ${hovered.y}) ${scale.toFixed(1)}x` : `${scale.toFixed(1)}x`}</span>
      <span>{notStarted ? `Starts in ${remaining}` : `${remaining} left`}</span>
    </div>
  );
}

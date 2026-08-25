"use client";

import { useEffect, useState } from "react";

export function WarHud({
  hovered,
  scale,
  endsAt,
}: {
  hovered: { x: number; y: number } | null;
  scale: number;
  endsAt: string;
}) {
  const [remaining, setRemaining] = useState("");

  useEffect(() => {
    const tick = () => {
      const ms = Math.max(0, Date.parse(endsAt) - Date.now());
      const hours = Math.floor(ms / 3_600_000);
      const minutes = Math.floor((ms % 3_600_000) / 60_000);
      const seconds = Math.floor((ms % 60_000) / 1000);
      setRemaining(
        `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`,
      );
    };
    tick();
    const timer = setInterval(tick, 1000);
    return () => clearInterval(timer);
  }, [endsAt]);

  return (
    <div className="pointer-events-none flex justify-between font-mono text-sm">
      <span>{hovered ? `(${hovered.x}, ${hovered.y}) ${scale.toFixed(1)}x` : `${scale.toFixed(1)}x`}</span>
      <span>{remaining} left</span>
    </div>
  );
}

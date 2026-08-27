"use client";

import { useEffect, useState } from "react";

/**
 * How long this war has left, as the thing it is.
 *
 * A war is 48 to 72 hours long and the ending is most of why anybody is
 * watching. This used to be the words "12:04:31 left" set in unstyled mono in
 * a strip above the canvas, next to the zoom level — which is where a page
 * puts a build number, not where it puts the stake.
 *
 * Mono and tabular is not decoration here: this element rewrites itself once
 * a second for two days, and proportional digits would make the whole rail
 * twitch on every tick.
 */
export function WarClock({
  startsAt,
  endsAt,
  notStarted,
  ended,
  onStart,
}: {
  startsAt: string;
  endsAt: string;
  notStarted: boolean;
  ended: boolean;
  onStart?: () => void;
}) {
  const [remaining, setRemaining] = useState("--:--:--");
  // A war that has not started counts down to its own opening, not to a clock
  // that has not begun ticking.
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

  const label = ended ? "Ended" : notStarted ? "Starts in" : "Time left";

  return (
    <section className="readout bevel-in flex flex-col gap-0.5 px-3 py-2.5">
      <h2 className="section-label">{label}</h2>
      {/* aria-live off: this updates every second, and a screen reader
          announcing a countdown once per second is unusable. The value is
          readable on demand; it is not an alert. */}
      <p className="clock" aria-live="off">
        {ended ? "00:00:00" : remaining}
      </p>
    </section>
  );
}

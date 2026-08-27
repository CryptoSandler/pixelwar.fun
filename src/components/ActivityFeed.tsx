"use client";

import { CHIP_OUTLINE } from "../lib/wars/chrome";
import { colourForSlot } from "../lib/wars/palette";

export type FeedEvent = {
  seq: number;
  x: number;
  y: number;
  colourSlot: number;
  ticker: string | null;
  paintedAt: string;
};

/**
 * Proof that other people are here.
 *
 * A canvas answers "is anything happening" badly. The board updates every
 * 1.5 seconds, but one pixel changing two hundred cells away is invisible —
 * and a visitor who cannot tell a live war from a screenshot leaves. This is
 * where those changes become legible as activity rather than as noise.
 *
 * KEYED BY `seq`, which is monotonic and gapless, so React reuses rows
 * instead of rebuilding the list every two seconds — a list that rebuilds
 * flickers, and a flickering feed reads as broken rather than as busy.
 *
 * No timestamps. "14:32:09" is not what anybody wants from a feed of things
 * that happened in the last minute, and a relative time ticking on twelve
 * rows twice a second is a rendering cost for information nobody reads. The
 * order IS the information.
 */
export function ActivityFeed({ events }: { events: FeedEvent[] }) {
  if (events.length === 0) {
    return (
      <p className="muted text-[12px]">
        Nobody has painted here yet. The first pixel is yours.
      </p>
    );
  }

  return (
    <ol className="flex flex-col gap-0.5">
      {events.map((event) => {
        let colour: string;
        try {
          colour = colourForSlot(event.colourSlot);
        } catch {
          return null;
        }
        return (
          <li key={event.seq} className="flex items-center gap-1.5 text-[12px]">
            {/* I2: the chip carries the outline for the surface it sits on. */}
            <span
              aria-hidden
              className="h-2.5 w-2.5 shrink-0"
              style={{
                background: colour,
                outline: `1px solid ${CHIP_OUTLINE.panel}`,
                outlineOffset: "-1px",
              }}
            />
            <span className="truncate">{event.ticker ?? "—"}</span>
            <span className="numeric ml-auto shrink-0">
              {event.x},{event.y}
            </span>
          </li>
        );
      })}
    </ol>
  );
}

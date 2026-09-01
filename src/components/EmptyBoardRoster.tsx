"use client";

import { CHIP_OUTLINE } from "../lib/wars/chrome";
import { flagColourForSlot } from "../lib/wars/palette";
import type { RailToken } from "./TokenRail";

/**
 * Who is standing on an empty board.
 *
 * THE PROBLEM IT SOLVES: a war that has opened but has no pixels yet renders
 * as a rectangle of `CANVAS_GROUND` and nothing else. The ground itself is
 * fine — invariant I3 requires it to be a neutral that no token can be, and
 * it measures out at #2E2E38 rather than the black it gets described as. What
 * is missing is not colour. It is that the war ALREADY HAS PROTAGONISTS, and
 * the screen shows none of them until somebody paints.
 *
 * So the empty board says who is here: the flags and the logos of the tokens
 * that have already paid to enter. That is the recruiting message — "these
 * communities are in, and nobody has taken any ground yet" — and it is true
 * only in this one moment, which is why it goes away rather than becoming
 * chrome.
 *
 * IT DISAPPEARS ON THE FIRST PIXEL, and never comes back. A board with paint
 * on it is the thing itself; anything drawn over it would be a label on art.
 */
export function EmptyBoardRoster({ tokens }: { tokens: RailToken[] }) {
  if (tokens.length === 0) return null;

  return (
    <div className="pointer-events-none absolute inset-0 flex items-center justify-center p-4">
      <div className="panel bevel flex max-w-[min(90%,420px)] flex-col gap-2 p-4">
        <p className="section-label">In this war</p>
        <ul className="flex flex-wrap gap-x-3 gap-y-2">
          {tokens.map((token) => {
            let flag: string;
            try {
              flag = flagColourForSlot(token.colourSlot);
            } catch {
              return null;
            }
            return (
              <li key={token.id} className="flex items-center gap-1.5">
                {/* I2: the chip carries the outline for the surface it is on.
                    This one is on a panel. */}
                <span
                  aria-hidden
                  className="h-3 w-3 shrink-0"
                  style={{
                    background: flag,
                    outline: `1px solid ${CHIP_OUTLINE.panel}`,
                    outlineOffset: "-1px",
                  }}
                />
                {token.logoUrl ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={token.logoUrl} alt="" aria-hidden width={16} height={16} />
                ) : null}
                <span className="ticker">{token.ticker}</span>
              </li>
            );
          })}
        </ul>
        <p className="muted text-[12px]">
          Nobody holds a pixel yet. The first paint decides who does.
        </p>
      </div>
    </div>
  );
}

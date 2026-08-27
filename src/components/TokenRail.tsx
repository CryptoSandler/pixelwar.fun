"use client";

import { CHIP_OUTLINE } from "../lib/wars/chrome";
import { flagColourForSlot } from "../lib/wars/palette";

export type RailToken = {
  id: string;
  ticker: string;
  name: string;
  colourSlot: number;
  owned: number;
};

export function TokenRail({
  tokens,
  selectedId,
  onSelect,
}: {
  tokens: RailToken[];
  selectedId: string | null;
  onSelect: (id: string) => void;
}) {
  return (
    <ul className="flex gap-2 overflow-x-auto md:flex-col">
      {tokens.map((token, index) => {
        // A TOKEN's colour is its flag, which wraps the palette past 24
        // tokens — not `colourForSlot`, which is strict because a painted
        // pixel outside the palette is a corrupt byte with no honest colour.
        //
        // /api/leaderboard is untrusted input, same as the canvas bytes
        // BoardImage renders — and BoardImage was deliberately hardened to
        // degrade a bad slot to unpainted rather than throw. flagColourForSlot
        // still throws RangeError on an out-of-range slot, which would take
        // down this whole page's render for one bad token. Same input, same
        // policy: skip the token we cannot render rather than crash.
        let colour: string;
        try {
          colour = flagColourForSlot(token.colourSlot);
        } catch {
          return null;
        }

        return (
          <li key={token.id}>
            <button
              type="button"
              onClick={() => onSelect(token.id)}
              aria-pressed={token.id === selectedId}
              className="flex items-center gap-2 rounded px-2 py-1"
            >
              {/* Every chip carries its outline, keyed by the surface it is
                  drawn on (DESIGN.md I2). This rail moved onto a PANEL when
                  the board screen was restyled, so the key moved with it —
                  an outline chosen for a dark shell is the wrong colour on a
                  light one, and #FFFFFF would vanish here exactly as #000000
                  vanished there. The fill cannot fix it: the fill is the
                  token's colour and is not ours to change. */}
              <span
                aria-hidden
                className="h-4 w-4 rounded-sm"
                style={{
                  background: colour,
                  outline: `1px solid ${CHIP_OUTLINE.panel}`,
                  outlineOffset: "-1px",
                }}
              />
              <span className="font-mono">{token.ticker}</span>
              {/* The count is not quiet text at all. It is the leaderboard —
                  pixels held right now, which DESIGN.md §8 calls the thing the
                  interface is for — and it was being dimmed to `opacity-70`
                  beside the ticker it belongs to. Full strength, and the two
                  now read as one row.

                  The hint below it IS ancillary, so it takes the quiet colour
                  and keeps the hierarchy the opacities were reaching for.
                  Named, because `opacity-40` rendered 3.63:1 — under the body
                  floor this owes as text somebody has to read to use it. */}
              <span className="tabular-nums">{token.owned}</span>
              {index < 9 ? (
                <kbd className="text-[var(--chrome-ink-muted-inverse)]">{index + 1}</kbd>
              ) : null}
            </button>
          </li>
        );
      })}
    </ul>
  );
}

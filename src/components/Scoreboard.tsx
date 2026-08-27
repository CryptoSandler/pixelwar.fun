"use client";

import { CHIP_OUTLINE } from "../lib/wars/chrome";
import { flagColourForSlot } from "../lib/wars/palette";
import type { RailToken } from "./TokenRail";

/**
 * Who is winning, readable without reading.
 *
 * WHAT CHANGED AND WHY. This was a list of tickers with a count beside each.
 * A list answers "who is here"; a war asks "who is winning", and those are
 * different questions — a number tells you the answer only after you have
 * read every other number and compared them. A bar does the comparison in
 * the visitor's peripheral vision, before they have decided to pay
 * attention.
 *
 * DOMINANCE IS COUNTED BY ATTRIBUTION, not by colour, and since the free
 * palette that distinction is load-bearing rather than pedantic: the colour
 * on the board tells you nothing about who owns a pixel. `owned` comes from
 * `token_pixel_counts`, which is keyed by token and has never had a colour
 * column near it.
 *
 * THE BAR IS THE TOKEN'S FLAG, and it is the one place a token's colour still
 * appears at size. That is deliberate: with painting decoupled from identity,
 * the scoreboard is where a community's colour still means the community. I5
 * is not at risk — brass is the accent and no flag is brass, because no token
 * colour clears the palette distance the accent had to.
 *
 * SCALED TO THE LEADER, not to the board. Early in a war every token owns a
 * fraction of a percent, and bars drawn against 40,000 cells are all zero
 * width — the scoreboard would be blank for the hours when watching it is
 * most interesting. The percentage beside the bar carries the absolute truth;
 * the bar carries the race.
 */
export function Scoreboard({
  tokens,
  boardPixels,
  selectedId,
  onSelect,
}: {
  tokens: RailToken[];
  /** Total cells on the board, for the share each token holds of it. */
  boardPixels: number;
  selectedId: string | null;
  onSelect: (id: string) => void;
}) {
  const ranked = [...tokens].sort((a, b) => b.owned - a.owned || a.colourSlot - b.colourSlot);
  const leader = ranked[0]?.owned ?? 0;

  if (ranked.length === 0) {
    return (
      <p className="muted text-[13px]">
        No tokens have joined this war yet.
      </p>
    );
  }

  return (
    <ol className="flex flex-col">
      {ranked.map((token) => {
        // /api/leaderboard is untrusted, and a slot outside the range throws.
        // Skip the row rather than take the page down — the same policy the
        // canvas uses for a byte it cannot render.
        let flag: string;
        try {
          flag = flagColourForSlot(token.colourSlot);
        } catch {
          return null;
        }

        const share = boardPixels > 0 ? (token.owned / boardPixels) * 100 : 0;
        // Below a tenth of a percent, "0.0%" is a rounding artefact that reads
        // as "none". A war's first hour is entirely made of this case.
        const shareText =
          token.owned === 0 ? "—" : share < 0.1 ? "<0.1%" : `${share.toFixed(1)}%`;
        const width = leader > 0 ? Math.max(token.owned > 0 ? 2 : 0, (token.owned / leader) * 100) : 0;
        const selected = token.id === selectedId;

        return (
          <li key={token.id}>
            <button
              type="button"
              onClick={() => onSelect(token.id)}
              aria-pressed={selected}
              className="score-row"
            >
              <span className="flex items-center gap-2">
                {/* I2: every chip carries the outline for the surface it is
                    drawn on. This one sits on a panel. Without it the white
                    token is invisible here and the black one nearly so. */}
                <span
                  aria-hidden
                  className="h-3 w-3 shrink-0"
                  style={{
                    background: flag,
                    outline: `1px solid ${CHIP_OUTLINE.panel}`,
                    outlineOffset: "-1px",
                  }}
                />
                <span className="ticker">{token.ticker}</span>
              </span>

              {/* The race. `aria-hidden` because the bar is a second rendering
                  of the number already announced beside it, and a screen
                  reader that reads both says everything twice. */}
              <span aria-hidden className="score-track">
                <span className="score-fill" style={{ width: `${width}%`, background: flag }} />
              </span>

              <span className="numeric text-[12px] tabular-nums">{shareText}</span>
            </button>
          </li>
        );
      })}
    </ol>
  );
}

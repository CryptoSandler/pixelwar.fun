"use client";

import { CHIP_OUTLINE } from "../lib/wars/chrome";
import { flagColourForSlot } from "../lib/wars/palette";
import type { RailToken } from "./TokenRail";

/**
 * Who is winning, readable without reading — and the selector, because they
 * were always the same list.
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
 * ONE COMPONENT, NOT TWO. This sat above a `TokenRail` that rendered the
 * identical tokens with the identical chips and a second click target for
 * the identical action: the rail was "which token am I painting for" and the
 * scoreboard was "how is that token doing", stacked, so the sidebar asked the
 * same question twice and answered it in two places. The row IS the selector.
 * `TokenRail` is gone.
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
        // ZERO IS 0%, NOT AN EM DASH. This read "—" for a token holding
        // nothing, on the reasoning that absolute zero and no-data are
        // different facts. They are — but an em dash is how a table says "no
        // data", so a token that genuinely holds none of the board looked
        // broken rather than losing. A war's first hour is entirely made of
        // this case.
        const shareText = share === 0 ? "0%" : share < 0.1 ? "<0.1%" : `${share.toFixed(1)}%`;
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
              <span className="flex items-center gap-1.5">
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
                {/* THE LOGO IS THE IDENTITY, and it is the thing neither
                    r/place nor wplace can have: their bands are anonymous
                    colour, ours are communities with a mark people already
                    recognise. It sits before the ticker because it is read
                    faster than a word. Decorative — the ticker beside it is
                    the accessible name — and it fails to nothing when a token
                    has no logo or the host is down. */}
                {token.logoUrl ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    src={token.logoUrl}
                    alt=""
                    aria-hidden
                    width={14}
                    height={14}
                    className="shrink-0"
                  />
                ) : null}
                <span className="ticker">{token.ticker}</span>
                {/*
                  WHICH WAY IT IS MOVING, and this is for the side that is
                  losing. A rank tells a community it is behind; it does not
                  tell them they are being taken apart right now, which is the
                  thing that brings people back to defend. Only shown when
                  there is movement — a zero here would be noise on every row
                  of a quiet board.

                  Not a colour. DESIGN.md I5 keeps the accent for actions, and
                  red/green would be a second colour language on a screen
                  whose colours already mean tokens. The sign carries it.
                */}
                {token.net !== 0 ? (
                  <span
                    className="numeric shrink-0 text-[11px]"
                    title={`${token.net > 0 ? "Took" : "Lost"} ${Math.abs(token.net)} pixels in the last 10 minutes`}
                  >
                    {/* THE ROW NOW CARRIES TWO BARE INTEGERS — this and the
                        painter count — and a `title` is not reliably
                        announced, so read aloud they would run together as
                        "minus three, twelve". `sr-only` is already how this
                        repo labels a control whose visible form is a glyph
                        (PaintPalette, JoinFlow); it costs one span and it is
                        the difference between a signal and a mystery number.
                        Sighted readers get the sign, which is the only thing
                        on this row that is signed. */}
                    <span className="sr-only">
                      {token.net > 0 ? "Took " : "Lost "}
                      {Math.abs(token.net)} pixels in the last 10 minutes:{" "}
                    </span>
                    <span aria-hidden>
                      {token.net > 0 ? "+" : "−"}
                      {Math.abs(token.net)}
                    </span>
                  </span>
                ) : null}
                {token.painters > 0 ? (
                  <span className="numeric shrink-0 text-[11px]" title={`${token.painters} painters`}>
                    {token.painters}
                  </span>
                ) : null}

                {/*
                  THE SWORN MARK, and it is the whole status ladder in one
                  glyph. `sworn` counts painters who proved a wallet holding
                  this token — a credential the community issues, never one
                  sold here (DESIGN.md §1a). It is rendered as a count rather
                  than a boolean because "nine holders are fighting for this"
                  is the recruiting message; "someone did" is not.

                  Not brass. The accent means an action a visitor can take
                  (I5), and this is a fact about other people.
                */}
                {token.sworn > 0 ? (
                  <span
                    className="numeric shrink-0 px-1 text-[11px]"
                    style={{ background: "var(--chrome-readout)" }}
                    title={`${token.sworn} of ${token.painters} painters hold this token`}
                  >
                    ✦{token.sworn}
                  </span>
                ) : null}
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

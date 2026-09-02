"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { FrozenBoard } from "./FrozenBoard";
import { WalletButton } from "./WalletButton";
import { CHIP_OUTLINE } from "../lib/wars/chrome";
import { flagColourForSlot } from "../lib/wars/palette";

/**
 * The screen between wars: a result, not an invitation.
 *
 * THAT FRAMING IS THE WHOLE DESIGN (DESIGN.md §5a). A visitor arriving here
 * sees a board they cannot paint on, and the only thing that stops that
 * reading as broken is the screen saying plainly that this is what happened
 * rather than what is happening. Every element serves it: the heading names
 * a result, the winner is named, and the one action offered is the one that
 * is actually available — entering a token in the next war.
 *
 * WHAT REPLACED WHAT. The home page used to answer "no war is running" with
 * three sentences on a bare background — no wordmark, no board, nothing that
 * said what this site is. That was the launch-day first impression, and a
 * finished board with a winner on it is the best piece of marketing this
 * product generates on its own.
 */

export type FinishedWar = {
  slug: string;
  title: string;
  width: number;
  height: number;
  endedAt: string;
  winner: { ticker: string; colourSlot: number; owned: number } | null;
};

export function Intermission({
  finished,
  nextOpensAt,
  nextTitle,
}: {
  /** The last war that ended, or null on a deployment that has never run one. */
  finished: FinishedWar | null;
  /** When the next war opens, if one is scheduled. */
  nextOpensAt: string | null;
  nextTitle: string | null;
}) {
  return (
    <main className="flex h-screen flex-col" style={{ background: "var(--chrome-surround)" }}>
      <header className="header-bar bevel flex shrink-0 items-center justify-between gap-3 px-4 py-2.5">
        {/* The wordmark is present in every state. Its absence was the whole
            defect: a stranger landing between wars had no way to learn what
            this site even is. */}
        <span
          className="shrink-0 text-[16px] font-medium tracking-[0.14em]"
          style={{ color: "var(--chrome-accent)" }}
        >
          PIXELWAR
        </span>
        <span className="flex shrink-0 items-center gap-2">
          <Link href="/join" className="btn-primary px-3 py-1.5">
            Add your token
          </Link>
          {/* Same place as every other screen. */}
          <WalletButton />
        </span>
      </header>

      <div className="flex min-h-0 flex-1 flex-col gap-3 p-3 rail:flex-row">
        <aside className="panel bevel flex shrink-0 flex-col gap-3 p-3 rail:w-[280px]">
          {nextOpensAt ? (
            <NextWar opensAt={nextOpensAt} title={nextTitle} />
          ) : (
            <section className="readout bevel-in flex flex-col gap-1 px-3 py-2.5">
              <h2 className="section-label">Next war</h2>
              <p className="text-[13px]">Not scheduled yet.</p>
            </section>
          )}

          {finished?.winner ? (
            <section className="flex flex-col gap-1">
              <h2 className="section-label">Took the board</h2>
              <p className="flex items-center gap-2 text-[15px] font-medium">
                <span
                  aria-hidden
                  className="h-3.5 w-3.5 shrink-0"
                  style={{
                    background: flagColourForSlot(finished.winner.colourSlot),
                    outline: `1px solid ${CHIP_OUTLINE.panel}`,
                    outlineOffset: "-1px",
                  }}
                />
                {finished.winner.ticker}
              </p>
              <p className="muted text-[13px]">
                {/* Grouped, like every other rendering of this number. The
                    result page and the share card both print "11,412" and
                    this printed "11412" — the same figure, on two screens
                    that now link to each other, in two formats. */}
                <span className="numeric">{finished.winner.owned.toLocaleString("en-US")}</span>{" "}
                pixels held at the end
                of {finished.title}.
              </p>
              {/*
                THE LINK IS THE POINT OF THE ARCHIVE EXISTING. `/wars/[slug]`
                is where a result stops being the thing that happens to be on
                the front page and becomes a URL a community can post — with
                its own share card, which `/` cannot have because `/` is a
                different war every week. Without a link from here the page
                is reachable only by typing it, which is the failure CLAUDE.md
                calls "every new module names its caller": two finished
                functions and no route to them is not a feature.
              */}
              <Link href={`/wars/${finished.slug}`} className="btn-secondary mt-1 px-3 py-1.5 text-center">
                See the full result
              </Link>
            </section>
          ) : null}

          {/* "200×200" was here until 2026-09-02 and had stopped being true:
              board size is per war (`wars.width`, `wars.height`), so the one
              sentence explaining the product was quoting a number the war
              behind it need not have. A sentence that describes every war is
              worth more here than a number that describes some of them. */}
          <p className="muted mt-auto text-[13px]">
            A war is a timed fight for one shared canvas. Communities take a slot and a flag
            colour; anyone paints, in any colour, and the scoreboard counts the pixels each token
            holds.
          </p>

          <p className="flex flex-wrap gap-x-3 gap-y-1">
            <Link href="/wars" className="muted text-[13px] underline underline-offset-2">
              Every war that has finished
            </Link>
            <Link href="/rules" className="muted text-[13px] underline underline-offset-2">
              Rules
            </Link>
          </p>
        </aside>

        <div className="flex min-h-0 min-w-0 flex-1 flex-col gap-2">
          <div className="readout bevel-in flex shrink-0 items-center justify-between px-3 py-1.5">
            {/* Says RESULT, in the place a live board says coordinates. This
                is the sentence that stops a non-paintable board reading as
                broken. */}
            <span className="section-label">
              {finished ? `Result — ${finished.title}` : "No war has run yet"}
            </span>
            {finished ? (
              <span className="numeric text-[12px]">
                {new Date(finished.endedAt).toLocaleDateString()}
              </span>
            ) : null}
          </div>

          <div className="board-frame relative min-h-0 flex-1">
            {finished ? (
              <FrozenBoard slug={finished.slug} width={finished.width} height={finished.height} />
            ) : (
              <div className="grid h-full place-items-center px-6 text-center">
                <p className="text-[13px] text-[var(--chrome-ink-inverse)]">
                  The first war has not run yet. Put your token in it.
                </p>
              </div>
            )}
          </div>
        </div>
      </div>
    </main>
  );
}

/**
 * The countdown, which is the dominant element when a war is scheduled.
 *
 * It outranks the result beside it on purpose: the result is context and the
 * countdown is the thing that is imminent and actionable. "This happened, and
 * the next one starts in 02:14:33" is a better screen than either half alone.
 */
function NextWar({ opensAt, title }: { opensAt: string; title: string | null }) {
  const [remaining, setRemaining] = useState("--:--:--");

  useEffect(() => {
    const tick = () => {
      const ms = Math.max(0, Date.parse(opensAt) - Date.now());
      const pad = (n: number) => String(n).padStart(2, "0");
      setRemaining(
        `${pad(Math.floor(ms / 3_600_000))}:${pad(Math.floor((ms % 3_600_000) / 60_000))}:${pad(Math.floor((ms % 60_000) / 1000))}`,
      );
    };
    tick();
    const timer = setInterval(tick, 1000);
    return () => clearInterval(timer);
  }, [opensAt]);

  return (
    <section className="readout bevel-in flex flex-col gap-0.5 px-3 py-2.5">
      <h2 className="section-label">Opens in</h2>
      <p className="clock" aria-live="off">
        {remaining}
      </p>
      {title ? <p className="muted text-[13px]">{title}</p> : null}
    </section>
  );
}

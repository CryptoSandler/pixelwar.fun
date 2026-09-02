import type { Metadata } from "next";
import Link from "next/link";
import { Cabinet } from "../../components/Cabinet";
import { winnersFor } from "../../lib/wars/archive";
import { CHIP_OUTLINE } from "../../lib/wars/chrome";
import { finishedWars } from "../../lib/wars/lifecycle";
import { flagColourForSlot } from "../../lib/wars/palette";

export const dynamic = "force-dynamic";

/**
 * The archive: every war that has finished, newest first.
 *
 * WHAT IT IS FOR, AND IT IS NOT COMPLETENESS. `/` shows the most recent
 * result and nothing else, so the moment a second war ends the first one is
 * unreachable — its board, its ranking and its share card all still render,
 * and no link anywhere in the product reaches them. This is the index that
 * makes a result outlive the week it happened in.
 *
 * "FINISHED" IS `finishedWars`, WHICH MEANS NOT EMPTY. A war that ended with
 * nothing on it is not listed. That is the same policy the intermission
 * applies and it is a single function so the two cannot drift — see
 * `lifecycle.ts`, where the reason is written.
 */
export const metadata: Metadata = {
  title: "Wars — pixelwar.fun",
  description: "Every war that has finished, with its final board and its result.",
};

export default async function WarsPage() {
  const wars = await finishedWars();
  const winners = await winnersFor(wars.map((war) => war.id));

  return (
    <Cabinet label="Archive">
      <section className="panel bevel flex flex-col gap-1 p-4">
        <h1 className="text-[20px] font-medium">Finished wars</h1>
        <p className="muted text-[13px]">
          Every war that has run to its end, newest first. Each one keeps its board and its
          result.
        </p>
      </section>

      {wars.length === 0 ? (
        <section className="panel bevel p-4">
          {/*
            The honest empty state. A deployment before its first war reaches
            this, and so does a deployment whose only wars ended with nothing
            painted on them — which is why the sentence says "finished" rather
            than "run".
          */}
          <p className="text-[13px]">No war has finished yet.</p>
          <p className="muted mt-2 text-[13px]">
            The first result will appear here, and on the front page, the moment one does.
          </p>
        </section>
      ) : (
        <ol className="flex flex-col gap-2">
          {wars.map((war) => {
            const winner = winners.get(war.id);
            return (
              <li key={war.id}>
                <Link
                  href={`/wars/${war.slug}`}
                  className="panel bevel flex flex-col gap-1 p-3 no-underline"
                >
                  <span className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
                    <span className="text-[15px] font-medium">{war.title}</span>
                    {/* Mono, tabular, like every other number (DESIGN.md §3). */}
                    <span className="numeric muted text-[12px]">
                      {(war.endedAt ?? war.endsAt).toISOString().slice(0, 10)}
                    </span>
                  </span>

                  {winner ? (
                    <span className="flex items-center gap-2 text-[13px]">
                      {/*
                        Chip AND ticker, never the chip alone (DESIGN.md §9).
                        The outline is what keeps #FFFFFF and #000000 — both
                        in the palette — from vanishing into the panel.
                      */}
                      <span
                        aria-hidden
                        className="h-3 w-3 shrink-0"
                        style={{
                          background: flagColourForSlot(winner.colourSlot),
                          outline: `1px solid ${CHIP_OUTLINE.panel}`,
                          outlineOffset: "-1px",
                        }}
                      />
                      <span className="ticker">{winner.ticker}</span>
                      <span className="numeric muted text-[12px]">
                        {winner.owned.toLocaleString("en-US")} px
                      </span>
                    </span>
                  ) : (
                    <span className="muted text-[13px]">Nobody held a pixel at the end.</span>
                  )}

                  <span className="numeric muted text-[11px]">
                    {war.width}×{war.height}
                  </span>
                </Link>
              </li>
            );
          })}
        </ol>
      )}

      <nav className="flex flex-wrap gap-2">
        <Link href="/rules" className="btn-secondary px-4 py-2">
          Rules
        </Link>
        <Link href="/" className="btn-primary px-4 py-2">
          Go to the board
        </Link>
      </nav>
    </Cabinet>
  );
}

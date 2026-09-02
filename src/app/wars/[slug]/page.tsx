import type { Metadata } from "next";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { Cabinet } from "../../../components/Cabinet";
import { FrozenBoard } from "../../../components/FrozenBoard";
import {
  finalStandings,
  paintedTotal,
  shareOfBoard,
  winnerOf,
  type FinalStanding,
} from "../../../lib/wars/archive";
import { CHIP_OUTLINE } from "../../../lib/wars/chrome";
import { advanceWar, warBySlug, type War } from "../../../lib/wars/lifecycle";
import { flagColourForSlot } from "../../../lib/wars/palette";

export const dynamic = "force-dynamic";

/**
 * One finished war, permanently.
 *
 * WHY A WAR NEEDS A URL OF ITS OWN. `/` renders the most recent result, and
 * it stops the moment the next war starts — so until this page a result had a
 * lifetime of one week and no address. A community that took a board could
 * not link to the fact. Everything here already existed in the database; what
 * did not exist was a page.
 *
 * A LIVE WAR IS REDIRECTED TO `/`, NOT RENDERED HERE. Two screens showing the
 * same live board would be two screens to keep in step, and only one of them
 * would have the paint button — so the other reads as the broken version of
 * the real thing. `/` is the live war; this is what is left of one.
 */

const BOARD_LABEL = "The board as it stood when the clock ran out.";

/**
 * A war and its result, read once and shared by the metadata and the page.
 *
 * Next runs `generateMetadata` and the component in the same request and
 * dedupes identical fetches, but these are database calls, which it cannot
 * see. Reading the war twice is the cost of not thinking about it; this makes
 * the second read explicit so it is at least visible.
 */
async function resultFor(slug: string): Promise<{ war: War; standings: FinalStanding[] } | null> {
  const found = await warBySlug(slug);
  if (!found) return null;
  const war = await advanceWar(found);
  return { war, standings: await finalStandings(war.id) };
}

export async function generateMetadata({
  params,
}: {
  params: Promise<{ slug: string }>;
}): Promise<Metadata> {
  const { slug } = await params;
  const result = await resultFor(slug);
  if (!result) return { title: "No such war — pixelwar.fun" };

  const { war, standings } = result;
  const winner = winnerOf(standings);

  const title = `${war.title} — pixelwar.fun`;
  const description = winner
    ? `${winner.ticker} took the board with ${winner.owned.toLocaleString("en-US")} pixels, ${shareOfBoard(winner.owned, war).toFixed(1)}% of a ${war.width}×${war.height} canvas.`
    : `A ${war.width}×${war.height} canvas that finished with nobody holding a pixel.`;

  /*
   * THE CARD IS NAMED HERE, WHICH IS WHAT MAKES `/og/[slug]` REACHABLE.
   * Nothing in the browser ever fetches that route — this is its only caller,
   * along with the one on `/`. A share image with no metadata entry pointing
   * at it is a route that exists and does nothing, which is the exact failure
   * CLAUDE.md names: finished, tested, and unreachable.
   *
   * ABSOLUTE, via `metadataBase`. A crawler is not on our origin, so a
   * relative `og:image` resolves against nothing and the card unfurls blank.
   */
  const image = {
    url: `/og/${war.slug}`,
    width: 1200,
    height: 630,
    alt: winner
      ? `${war.title}: the final board, won by ${winner.ticker}.`
      : `${war.title}: the final board.`,
  };

  return {
    title,
    description,
    openGraph: {
      title,
      description,
      type: "article",
      url: `/wars/${war.slug}`,
      images: [image],
    },
    twitter: {
      // The wide card: the board is the content and a thumbnail throws it
      // away. `summary` would crop a 1200×630 image to a square and cut the
      // winner off the side it is written on.
      card: "summary_large_image",
      title,
      description,
      images: [image],
    },
  };
}

export default async function WarResultPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const result = await resultFor(slug);
  if (!result) notFound();

  const { war, standings } = result;
  if (war.status !== "ended") redirect("/");

  const winner = winnerOf(standings);
  const painted = paintedTotal(standings);
  const endedAt = war.endedAt ?? war.endsAt;

  return (
    <Cabinet label="Result">
      <section className="panel bevel flex flex-col gap-1 p-4">
        <span className="section-label muted">Result</span>
        <h1 className="text-[20px] font-medium">{war.title}</h1>
        <p className="muted text-[13px]">
          Ended{" "}
          <time className="numeric" dateTime={endedAt.toISOString()}>
            {endedAt.toISOString().slice(0, 10)}
          </time>
          {" · "}
          <span className="numeric">
            {war.width}×{war.height}
          </span>
          {" · "}
          <span className="numeric">{painted.toLocaleString("en-US")}</span> pixels painted
        </p>
      </section>

      {winner ? (
        <section className="panel bevel flex flex-col gap-1 p-4">
          <h2 className="section-label muted">Took the board</h2>
          <p className="flex items-center gap-2 text-[17px] font-medium">
            <span
              aria-hidden
              className="h-4 w-4 shrink-0"
              style={{
                background: flagColourForSlot(winner.colourSlot),
                outline: `1px solid ${CHIP_OUTLINE.panel}`,
                outlineOffset: "-1px",
              }}
            />
            {winner.ticker}
          </p>
          <p className="muted text-[13px]">
            {winner.name} held <span className="numeric">{winner.owned.toLocaleString("en-US")}</span>{" "}
            pixels at the end — <span className="numeric">{shareOfBoard(winner.owned, war).toFixed(1)}%</span>{" "}
            of the board.
          </p>
        </section>
      ) : (
        <section className="panel bevel p-4">
          <p className="text-[13px]">This war finished with nobody holding a pixel.</p>
        </section>
      )}

      <section className="flex flex-col gap-2">
        <div className="readout bevel-in flex items-center justify-between px-3 py-1.5">
          <span className="section-label">The final board</span>
          <span className="numeric text-[12px]">{war.slug}</span>
        </div>
        {/*
          A SQUARE BOX, NOT A VIEWPORT-HEIGHT ONE. `/` gives the board every
          pixel of the screen because the board is the event; here it is one
          section of a document that also has a ranking under it, and a board
          sized to the viewport would push the ranking off the bottom on every
          phone. `aspect-square` also means the box is the same shape as the
          artwork, so `Board`'s own letterboxing has nothing to do.
        */}
        <div className="board-frame relative aspect-square w-full">
          <FrozenBoard slug={war.slug} width={war.width} height={war.height} />
        </div>
        <p className="muted text-[12px]">{BOARD_LABEL}</p>
      </section>

      <Standings standings={standings} war={war} />

      <nav className="flex flex-wrap gap-2">
        <Link href="/wars" className="btn-secondary px-4 py-2">
          Every finished war
        </Link>
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

/**
 * The final table.
 *
 * HELD AND PLACED, BOTH, AND THE GAP IS THE STORY. DESIGN.md §8 forbids copy
 * that implies a pixel is permanent, and a table with only one number invites
 * exactly that reading. A token that placed forty thousand pixels and held two
 * hundred was fought to a standstill all war, and neither figure says so
 * alone.
 *
 * NO RACE TINT BEHIND THESE ROWS, unlike the live scoreboard. That tint is
 * capped by `ROW_FILL_ALPHA`, a MEASURED ceiling against one surface carrying
 * one ink — and a new surface with a colour composited over it is precisely
 * the class of risk DECISIONES.md records for the scoreboard row. This table
 * is read once, not scanned every two seconds, and the share column already
 * carries the proportion, so the tint would be buying very little at the price
 * of a second contrast argument.
 */
function Standings({ standings, war }: { standings: FinalStanding[]; war: War }) {
  if (standings.length === 0) {
    return (
      <section className="panel bevel p-4">
        <p className="text-[13px]">No token entered this war.</p>
      </section>
    );
  }

  return (
    <section className="panel bevel flex flex-col gap-2 p-4">
      <h2 className="section-label muted">Final standings</h2>
      {/*
        The table scrolls inside its own box rather than making the page
        scroll sideways. At 390px the four columns fit; this is the guard for
        a long ticker rather than the normal case.
      */}
      <div className="overflow-x-auto">
        <table className="w-full text-left text-[13px]">
          <thead>
            <tr className="muted">
              <th scope="col" className="section-label py-1 pr-2 font-normal">
                Token
              </th>
              <th scope="col" className="section-label py-1 pr-2 text-right font-normal">
                Held
              </th>
              <th scope="col" className="section-label py-1 pr-2 text-right font-normal">
                Placed
              </th>
              <th scope="col" className="section-label py-1 text-right font-normal">
                Board
              </th>
            </tr>
          </thead>
          <tbody>
            {standings.map((standing) => (
              <tr key={standing.warTokenId}>
                <td className="py-1 pr-2">
                  <span className="flex items-center gap-2">
                    <span
                      aria-hidden
                      className="h-3 w-3 shrink-0"
                      style={{
                        background: flagColourForSlot(standing.colourSlot),
                        outline: `1px solid ${CHIP_OUTLINE.panel}`,
                        outlineOffset: "-1px",
                      }}
                    />
                    {/* The ticker is always beside the chip: DESIGN.md §9
                        forbids identity carried by colour alone. */}
                    <span className="ticker">{standing.ticker}</span>
                  </span>
                </td>
                <td className="numeric py-1 pr-2 text-right">
                  {standing.owned.toLocaleString("en-US")}
                </td>
                <td className="numeric muted py-1 pr-2 text-right">
                  {standing.placed.toLocaleString("en-US")}
                </td>
                <td className="numeric muted py-1 text-right">
                  {shareOfBoard(standing.owned, war) < 0.1 && standing.owned > 0
                    ? "<0.1%"
                    : `${shareOfBoard(standing.owned, war).toFixed(1)}%`}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="muted text-[12px]">
        Held is what a token owned when the clock stopped. Placed is every pixel its painters ever
        put down, including the ones taken back.
      </p>
    </section>
  );
}

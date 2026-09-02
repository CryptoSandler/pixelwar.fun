import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { ImageResponse } from "next/og";
import { encodeBoardPng, fitScale } from "../../../lib/canvas/board-png";
import { canvasBytes } from "../../../lib/canvas/state";
import { finalStandings, shareOfBoard, winnerOf } from "../../../lib/wars/archive";
import { ACCENT, CHIP_OUTLINE, CHROME_SURFACES, INK, INK_INVERSE } from "../../../lib/wars/chrome";
import { advanceWar, warBySlug } from "../../../lib/wars/lifecycle";
import { flagColourForSlot, rgba } from "../../../lib/wars/palette";

/**
 * The share card: a war's board and its winner, as one PNG.
 *
 * THIS IS THE PRODUCT'S DISTRIBUTION AND IT DID NOT EXIST. A war ends, a
 * community wants to post that they took the board, and until this route there
 * was no image to post — the result lived only on `/`, where the next war
 * replaces it, and a link unfurled as a bare URL. DESIGN.md §5a already says a
 * finished board with a winner on it is the best marketing this product
 * generates on its own; this is the part that lets it leave the site.
 *
 * **Its callers are `generateMetadata` in `app/wars/[slug]/page.tsx` and in
 * `app/page.tsx`**, which name it in `openGraph.images` and `twitter.images`.
 * Nothing in the browser fetches it — a crawler does.
 *
 * WHY THE BOARD IS AN EMBEDDED PNG RATHER THAN DRAWN HERE. Satori renders
 * flexbox and text; it has no pixel grid, and forty thousand `<div>`s is not a
 * technique. `board-png.ts` encodes the board's own bytes as an indexed PNG —
 * with the scale baked in, so nothing downstream gets to resample the grid —
 * and it arrives here as one `<img>`.
 */

/**
 * Read once, at module scope, because the faces do not depend on the request.
 *
 * `next/og` would otherwise render in the Geist it bundles, which is a
 * typeface this product uses nowhere. See `../fonts/README.md` for why that
 * was refused, and `next.config.ts` for what makes these files exist in a
 * deployed function at all.
 */
const FONT_DIR = join(process.cwd(), "src", "app", "og", "fonts");
const jostRegular = await readFile(join(FONT_DIR, "Jost-Regular.ttf"));
const jostMedium = await readFile(join(FONT_DIR, "Jost-Medium.ttf"));
const plexMono = await readFile(join(FONT_DIR, "IBMPlexMono-Regular.ttf"));

const WIDTH = 1200;
const HEIGHT = 630;

/** The dark strip across the top, which is `.header-bar` on every screen. */
const HEADER_HEIGHT = 84;

/** How much room the board gets, before its frame. */
const BOARD_BOX = 400;

/** The board frame's inner line, `--board-inset` in globals.css. */
const BOARD_INSET = "#60619C";

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ slug: string }> },
): Promise<Response> {
  const { slug } = await params;

  const found = await warBySlug(slug);
  if (!found) return new Response("No such war", { status: 404 });

  // Advanced for the same reason every other reader advances: a war whose
  // clock ran out eleven minutes ago must not describe itself as live because
  // nobody triggered a job.
  const war = await advanceWar(found);

  const [{ bytes }, standings] = await Promise.all([
    canvasBytes(war, "colour"),
    finalStandings(war.id),
  ]);

  const winner = winnerOf(standings);
  const scale = fitScale(war.width, war.height, BOARD_BOX);
  const board = encodeBoardPng(bytes, war.width, war.height, rgba(), scale);
  const boardSrc = `data:image/png;base64,${board.png.toString("base64")}`;

  const ended = war.status === "ended";

  // Assembled here rather than inline, for the same reason as above: one
  // string is one child, and Satori counts children.
  const footnote = [
    `${standings.length} ${standings.length === 1 ? "token" : "tokens"}`,
    `${war.width}\u00d7${war.height}`,
    ended && war.endedAt ? war.endedAt.toISOString().slice(0, 10) : null,
  ]
    .filter(Boolean)
    .join(" · ");

  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          flexDirection: "column",
          background: CHROME_SURFACES.surround,
          fontFamily: "Jost",
          color: INK,
        }}
      >
        {/*
          The header strip, and it is not decoration. `ACCENT` reads 5.19:1 on
          the header and **1.39:1 on the surround** — the wordmark cannot be
          drawn on the body of this card at all, and the strip is what makes
          the one brass element on the image legible. Measured rather than
          eyeballed; the numbers live in `chrome.ts`.
        */}
        <div
          style={{
            height: HEADER_HEIGHT,
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            padding: "0 44px",
            background: CHROME_SURFACES.header,
          }}
        >
          <div style={{ fontSize: 30, fontWeight: 500, letterSpacing: "0.14em", color: ACCENT }}>
            PIXELWAR
          </div>
          <div style={{ fontSize: 22, letterSpacing: "0.06em", color: INK_INVERSE }}>
            pixelwar.fun
          </div>
        </div>

        <div style={{ flex: 1, display: "flex", padding: 44, alignItems: "center" }}>
          {/*
            The board, mounted rather than embedded (DESIGN.md §4): a 3px
            frame in the header's ink with a 2px inset line inside it, which
            is `.board-frame` written in the subset of CSS Satori speaks.
          */}
          <div style={{ display: "flex", padding: 3, background: CHROME_SURFACES.header }}>
            <div style={{ display: "flex", padding: 2, background: BOARD_INSET }}>
              {/*
                A RAW <img>, AND `next/image` IS NOT AN OPTION HERE. This tree
                is never rendered by a browser — Satori reads it and rasterises
                it — so there is no LCP to improve and no loader to run. The
                rule this suppresses is about pages; this is a picture.
              */}
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={boardSrc} width={board.width} height={board.height} alt="" />
            </div>
          </div>

          <div
            style={{
              flex: 1,
              display: "flex",
              flexDirection: "column",
              paddingLeft: 44,
              minWidth: 0,
              height: "100%",
            }}
          >
            <div style={{ fontSize: 20, letterSpacing: "0.14em", fontFamily: "IBM Plex Mono" }}>
              {ended ? "RESULT" : "LIVE NOW"}
            </div>

            {/*
              The title, clamped deliberately. Satori will set a sixty-character
              war title at 54px across four lines and push the winner off the
              bottom of a fixed-height image — a card that silently loses its
              own headline. Two lines, then ellipsis.
            */}
            <div
              style={{
                fontSize: 54,
                fontWeight: 500,
                lineHeight: 1.1,
                marginTop: 10,
                display: "-webkit-box",
                WebkitBoxOrient: "vertical",
                WebkitLineClamp: 2,
                overflow: "hidden",
              }}
            >
              {war.title}
            </div>

            {winner ? (
              <div style={{ display: "flex", flexDirection: "column", marginTop: 30 }}>
                <div style={{ fontSize: 18, letterSpacing: "0.14em", fontFamily: "IBM Plex Mono" }}>
                  {ended ? "TOOK THE BOARD" : "LEADING"}
                </div>
                <div style={{ display: "flex", alignItems: "center", marginTop: 10 }}>
                  {/*
                    Chip plus ticker, never the chip alone. DESIGN.md §9: token
                    identity is never carried by colour alone, and a share card
                    is the one surface where a viewer cannot hover anything to
                    find out. The outline is `CHIP_OUTLINE.panel`, the
                    light-surface key, because #FFFFFF and #000000 are both in
                    the palette and one of them vanishes on any ground without
                    it.
                  */}
                  <div
                    style={{
                      width: 34,
                      height: 34,
                      marginRight: 14,
                      background: flagColourForSlot(winner.colourSlot),
                      border: `2px solid ${CHIP_OUTLINE.panel}`,
                    }}
                  />
                  <div style={{ fontSize: 44, fontWeight: 500, letterSpacing: "0.06em" }}>
                    {winner.ticker}
                  </div>
                </div>
                {/*
                  ONE STRING CHILD, NOT SEVERAL. Satori refuses any element
                  with more than one child that has not declared a `display`,
                  and a JSX line interleaving text and expressions produces
                  exactly that — several children. It throws at render time,
                  which on this route means the card 500s and nothing else in
                  the application notices. Building the sentence first is the
                  cheap way to stay inside the subset.
                */}
                <div style={{ fontSize: 24, marginTop: 12, fontFamily: "IBM Plex Mono" }}>
                  {`${winner.owned.toLocaleString("en-US")} pixels · ${shareOfBoard(winner.owned, war).toFixed(1)}% of the board`}
                </div>
              </div>
            ) : (
              /*
                NULL IS A DISTINCT ANSWER, not a zero — `winnerOf` refuses to
                invent a leader on a board nobody holds, and this is the
                sentence that goes in the space instead. "T3 took the board
                with 0 pixels" would be a headline about nothing.
              */
              <div style={{ fontSize: 26, marginTop: 30 }}>
                Nobody holds a pixel on this board yet.
              </div>
            )}

            <div style={{ fontSize: 20, marginTop: "auto", fontFamily: "IBM Plex Mono" }}>
              {footnote}
            </div>
          </div>
        </div>
      </div>
    ),
    {
      width: WIDTH,
      height: HEIGHT,
      fonts: [
        /*
         * STATIC INSTANCES, AND THAT IS A BUG FIX RATHER THAN A PREFERENCE.
         * The first version of this route loaded Jost's VARIABLE `.ttf` — the
         * file `github.com/google/fonts` ships — and Satori's font parser
         * threw inside `parseFvarAxis` before rendering a single pixel. It
         * cannot read an `fvar` table. The failure is total and it happens at
         * request time, which is why `share-card.test.ts` renders a real card
         * rather than trusting the pieces: nothing else in this project would
         * ever have loaded this route.
         *
         * So both weights are separate files, which also means the card can
         * use DESIGN.md §3's actual type scale — 500 for the wordmark, the
         * title and a ticker — instead of building hierarchy out of size
         * alone.
         */
        { name: "Jost", data: jostRegular, style: "normal", weight: 400 },
        { name: "Jost", data: jostMedium, style: "normal", weight: 500 },
        { name: "IBM Plex Mono", data: plexMono, style: "normal", weight: 400 },
      ],
      headers: {
        /*
         * THE SAME SIXTY SECONDS `/api/canvas` GIVES AN ENDED BOARD, AND FOR
         * THE SAME REASON. "Ended" is not forever: `reviveWar` can bring a war
         * back, and a card cached permanently at a social platform's edge
         * cannot be recalled — it would keep showing a board that stopped
         * changing, under a heading that says RESULT, for a war that is live
         * again. Long enough that a post going round does not re-render this
         * per view; short enough to recover from. Raising it is the change
         * that needs an argument; lowering it is always safe.
         */
        "cache-control": ended
          ? "public, max-age=60, s-maxage=60"
          : "public, s-maxage=30, stale-while-revalidate=60",
      },
    },
  );
}

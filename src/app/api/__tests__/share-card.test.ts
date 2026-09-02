import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { makeToken, makeWar, paintRaw } from "../../../lib/canvas/__tests__/fixtures";
import { execute } from "../../../lib/db";

const { GET: cardRoute } = await import("../../og/[slug]/route");

/**
 * The share card, rendered for real.
 *
 * WHY THIS RUNS THE WHOLE PIPELINE rather than unit-testing the pieces.
 * `board-png.ts` is tested on its own and thoroughly; what is NOT provable
 * from that side is that Satori accepts the data URI, that the two vendored
 * typefaces parse, and that a PNG comes out the other end at the size a
 * crawler was promised in the metadata. Every one of those fails at request
 * time, in production, on a route nobody loads in a browser — which is the
 * definition of a failure that ships.
 */

async function card(status: "live" | "ended") {
  const war = await makeWar({ width: 100, height: 100 });
  const token = await makeToken(war.id, 5);
  await paintRaw(war.id, 0, token, 5, 1);
  await paintRaw(war.id, 1, token, 12, 2);
  await execute(
    `UPDATE token_pixel_counts SET owned = 2, placed = 2 WHERE war_id = $1 AND war_token_id = $2`,
    [war.id, token],
  );
  if (status === "ended") {
    await execute(
      `UPDATE wars SET status = 'ended', ended_at = now(), ends_at = now() WHERE id = $1`,
      [war.id],
    );
  }
  const response = await cardRoute(new Request(`https://pixelwar.fun/og/${war.slug}`), {
    params: Promise.resolve({ slug: war.slug }),
  });
  return { war, response };
}

/** PNG's signature, then IHDR's width and height as big-endian 32-bit ints. */
function pngSize(bytes: Buffer): { width: number; height: number } {
  expect([...bytes.subarray(0, 8)]).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  expect(bytes.subarray(12, 16).toString("ascii")).toBe("IHDR");
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
}

describe("GET /og/[slug]", () => {
  it("renders a PNG at exactly the size the metadata promises", { timeout: 60_000 }, async () => {
    const { response } = await card("ended");
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("image/png");

    const bytes = Buffer.from(await response.arrayBuffer());

    // 1200x630 IS A CONTRACT, not a preference. Both pages declare those
    // numbers in `openGraph.images`, and a crawler that is told one size and
    // served another either letterboxes the card or rejects it.
    expect(pngSize(bytes)).toEqual({ width: 1200, height: 630 });

    // A card that rendered nothing is still a valid PNG. A blank 1200x630
    // deflates to almost nothing, so a floor on the size is what tells
    // "rendered" apart from "rendered empty" — a real board and two
    // typefaces cannot come to a couple of kilobytes.
    expect(bytes.length).toBeGreaterThan(5_000);
  });

  it("404s for a war that does not exist", { timeout: 30_000 }, async () => {
    const response = await cardRoute(new Request("https://pixelwar.fun/og/nope"), {
      params: Promise.resolve({ slug: "nope" }),
    });
    expect(response.status).toBe(404);
  });

  /**
   * THE SAME CEILING `/api/canvas` HOLDS, and for the same reason one file
   * over: "ended" is not forever, `reviveWar` can bring a war back, and a card
   * cached at a social platform's edge cannot be recalled. This is the copy of
   * that rule that applies to an image, and it needs its own assertion because
   * `canvas-cache.test.ts` cannot see this route.
   */
  it("caches an ended war's card for at most a minute, and never immutably", { timeout: 60_000 }, async () => {
    const { response } = await card("ended");
    const cache = response.headers.get("cache-control") ?? "";
    const maxAge = Number(/max-age=(\d+)/.exec(cache)?.[1] ?? Number.NaN);
    expect(Number.isFinite(maxAge)).toBe(true);
    expect(maxAge).toBeLessThanOrEqual(60);
    expect(cache).not.toMatch(/immutable/);
  });

  it("keeps a live war's card on a revalidating cache", { timeout: 60_000 }, async () => {
    const { response } = await card("live");
    const cache = response.headers.get("cache-control") ?? "";
    expect(cache).toMatch(/s-maxage/);
    expect(cache).toMatch(/stale-while-revalidate/);
  });

  it("keeps the reason for the ceiling beside the header", () => {
    // A number defended only by a test in another file is a number somebody
    // deletes, and its failure then reads as a mystery rather than as an
    // argument. Comment markers stripped and whitespace collapsed: these
    // sentences are hard-wrapped, and matching the raw file would assert
    // where an editor broke the line.
    const route = readFileSync("src/app/og/[slug]/route.tsx", "utf8")
      .replace(/^\s*\*+ ?/gm, "")
      .replace(/\s+/g, " ");
    expect(route).toContain("reviveWar` can bring a war back");
    expect(route).toContain("Raising it is the change that needs an argument");
  });
});

/**
 * WHO CALLS THIS ROUTE.
 *
 * Nothing in the browser does — a crawler does, after reading a `<meta>` tag
 * this application had to write. CLAUDE.md's rule is that every new module
 * names its caller and that the test which catches a missing wire drives the
 * CALLER, not the callee: `expireStaleOrders` and `recoverUnclaimedOrders`
 * were both finished, both tested, both reviewed, and neither was invoked
 * anywhere in the application.
 *
 * A share card with no metadata entry pointing at it is exactly that shape of
 * nothing. These assertions falsify by deleting the `openGraph` block.
 */
describe("the card is named by the pages that own it", () => {
  const source = (path: string) => readFileSync(path, "utf8").replace(/\s+/g, " ");

  it("is named by the war result page, in both card formats", () => {
    const page = source("src/app/wars/[slug]/page.tsx");
    expect(page).toContain("url: `/og/${war.slug}`");
    expect(page).toContain("openGraph:");
    expect(page).toContain('card: "summary_large_image"');
  });

  it("is named by the front page", () => {
    const page = source("src/app/page.tsx");
    expect(page).toContain("url: `/og/${war.slug}`");
    expect(page).toContain('card: "summary_large_image"');
  });

  /**
   * THE CONTROL. Every assertion above is a `toContain` against a file read
   * from disk, and a read that silently produced the wrong file — a rename, a
   * moved route — fails identically to a deleted `openGraph` block. This
   * names something unmissable in each file, so "the wire is gone" and "the
   * read is broken" are two different failures.
   */
  it("is reading the files it thinks it is", () => {
    expect(source("src/app/wars/[slug]/page.tsx")).toContain("export default async function WarResultPage");
    expect(source("src/app/page.tsx")).toContain("export default async function Page");
  });

  /**
   * And the card is useless without an origin to resolve against: a relative
   * `og:image` at a crawler resolves to nothing at all.
   */
  it("has an absolute base to resolve against", () => {
    expect(source("src/app/layout.tsx")).toContain("metadataBase: publicOrigin()");
  });
});

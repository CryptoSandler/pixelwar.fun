import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { makeToken, makeWar, paintRaw } from "../../../lib/canvas/__tests__/fixtures";
import { execute } from "../../../lib/db";

const { GET: canvasRoute } = await import("../canvas/route");

/**
 * An ended war's board may not be cached for long, because it may stop being
 * ended.
 *
 * THE RULE THIS DEFENDS, and it is already written in the route:
 *
 *   "'ended' is not actually forever: an operator can extend a war after the
 *    fact... A year-long immutable response cannot be recalled once a client
 *    has cached it, so an ended board gets a short cache instead of a
 *    permanent one — long enough to matter, short enough to recover from."
 *
 * That reasoning was a comment and nothing else. `reviveWar` now makes the
 * premise real — an operator CAN bring an ended war back — and the sixty
 * seconds is the only thing between a revived war and clients showing a
 * frozen board. Nothing stopped somebody "optimising" it to a year, and a
 * cached response cannot be recalled.
 */
describe("the cache ceiling on an ended war", () => {
  async function boardResponse(status: "live" | "ended") {
    const war = await makeWar({ width: 100, height: 100 });
    const token = await makeToken(war.id, 3);
    await paintRaw(war.id, 0, token, 5, 1);
    if (status === "ended") {
      await execute(`UPDATE wars SET status = 'ended', ended_at = now(), ends_at = now() WHERE id = $1`, [war.id]);
    }
    return canvasRoute(new Request(`https://pixelwar.fun/api/canvas?war=${war.slug}`));
  }

  it("caches an ended board for at most a minute", { timeout: 30_000 }, async () => {
    const response = await boardResponse("ended");
    const cache = response.headers.get("cache-control") ?? "";

    const maxAge = Number(/max-age=(\d+)/.exec(cache)?.[1] ?? Number.NaN);
    expect(Number.isFinite(maxAge)).toBe(true);
    // The ceiling, not the exact value: lowering it is always safe, raising
    // it is the change that needs an argument.
    expect(maxAge).toBeLessThanOrEqual(60);
    // And never immutable, which is the one directive that cannot be
    // recovered from at all.
    expect(cache).not.toMatch(/immutable/);
  });

  it("keeps a live board on a revalidating cache, not a fixed age", { timeout: 30_000 }, async () => {
    const response = await boardResponse("live");
    const cache = response.headers.get("cache-control") ?? "";
    expect(cache).toMatch(/s-maxage/);
    expect(cache).toMatch(/stale-while-revalidate/);
  });

  it("keeps the reason next to the header, where the next person will read it", () => {
    // A number defended by a test in another file is a number somebody
    // deletes. The comment and the assertion have to travel together, so
    // this asserts the explanation still exists at the site of the decision.
    // Comment markers stripped and whitespace collapsed: the sentence is
    // hard-wrapped across three lines, and matching the raw file would be
    // asserting where the author's editor broke the line rather than what it
    // says.
    const route = readFileSync("src/app/api/canvas/route.ts", "utf8")
      .replace(/^\s*\/\/ ?/gm, "")
      .replace(/\s+/g, " ");
    expect(route).toContain("an operator can extend a war after the fact");
    expect(route).toContain("Raising it is the change that needs an argument");
  });
});

import { beforeEach, describe, expect, it } from "vitest";
import { execute } from "../../../lib/db";
import { makeToken, makeWar, paintRaw } from "../../../lib/canvas/__tests__/fixtures";

/**
 * THE ROUTE, NOT THE FUNCTION.
 *
 * `momentum.test.ts` already proves the arithmetic, and it would go on
 * passing if nothing in the application ever called `territoryMomentum` —
 * which is exactly how this project shipped `expireStaleOrders` and
 * `recoverUnclaimedOrders`, both finished, both tested, both reachable from
 * nowhere (CLAUDE.md, "Every new module names its caller").
 *
 * So these drive `GET /api/leaderboard` and assert the effect on the wire.
 * Falsify them by deleting the `territoryMomentum` call in the route, or the
 * `t.logo_url` column from its SELECT: both go red here and nowhere else.
 *
 * The logo is in the same file for the same reason. It is not decoration —
 * the first server render carried it and the two-second poll dropped it, so a
 * logo appeared on screen and vanished again. That is a wiring defect and it
 * is invisible to any test of a component.
 */

async function leaderboard(slug: string) {
  const { GET } = await import("../leaderboard/route");
  const response = await GET(new Request(`https://pixelwar.fun/api/leaderboard?war=${slug}`));
  expect(response.status).toBe(200);
  return (await response.json()) as {
    tokens: Array<{ id: string; logoUrl: string | null; owned: number; net: number }>;
  };
}

const LOGO = "https://example.invalid/logo.png";

let war: Awaited<ReturnType<typeof makeWar>>;
let red: string;
let blue: string;

beforeEach(async () => {
  war = await makeWar({ width: 8, height: 8 });
  red = await makeToken(war.id, 1);
  blue = await makeToken(war.id, 2);
  await execute(`UPDATE war_tokens SET logo_url = $2 WHERE id = $1`, [red, LOGO]);
});

describe("what the leaderboard poll actually carries", () => {
  it("reports which way the board is moving, per token", { timeout: 30_000 }, async () => {
    // Red takes a blank cell; blue then takes it off red. Both events are
    // minutes old by construction — `paintRaw` stamps `now()` — so both are
    // inside the ten-minute window.
    await paintRaw(war.id, 10, red, 1, 1);
    await paintRaw(war.id, 10, blue, 2, 2);

    const body = await leaderboard(war.slug);
    const byId = new Map(body.tokens.map((token) => [token.id, token]));

    // Blue took one and lost none. Red took one and then lost it.
    expect(byId.get(blue)?.net).toBe(1);
    expect(byId.get(red)?.net).toBe(0);
  });

  it("carries a token's logo on every poll, not only the first render", { timeout: 30_000 }, async () => {
    const body = await leaderboard(war.slug);
    const byId = new Map(body.tokens.map((token) => [token.id, token]));

    expect(byId.get(red)?.logoUrl).toBe(LOGO);
    // Null rather than absent: the client renders nothing for it, and a
    // missing key would be indistinguishable from the column being dropped.
    expect(byId.get(blue)?.logoUrl).toBeNull();
  });

  it("reports zero movement on a board nobody has touched", { timeout: 30_000 }, async () => {
    // Not "omits the field". A row with no `net` at all would make the client
    // fall back to its own default and hide exactly the regression above.
    const body = await leaderboard(war.slug);
    for (const token of body.tokens) expect(token.net).toBe(0);
  });
});

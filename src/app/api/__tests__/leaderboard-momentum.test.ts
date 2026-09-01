import { beforeEach, describe, expect, it } from "vitest";
import { execute, queryOne } from "../../../lib/db";
import { makeToken, makeWar } from "../../../lib/canvas/__tests__/fixtures";
import { MOMENTUM_MINUTES } from "../../../lib/canvas/momentum";

/**
 * THE ROUTE, NOT THE FUNCTION.
 *
 * `momentum.test.ts` proves the arithmetic, and it would go on passing if
 * nothing in the application ever called it — which is exactly how this
 * project shipped `expireStaleOrders` and `recoverUnclaimedOrders`, both
 * finished, both tested, both reachable from nowhere (CLAUDE.md, "Every new
 * module names its caller").
 *
 * There are TWO wirings here and each is worth its own test, because the read
 * would keep working for a while after the write stopped: snapshots already
 * on disk would age into the window and then run out, so a broken writer
 * looks like a working feature until nobody is watching. Falsify these by
 * deleting `snapshotTokenCounts(war.id)` or `territoryMomentum(war.id)` from
 * the route, or the `t.logo_url` column from its SELECT.
 */

async function leaderboard(slug: string) {
  const { GET } = await import("../leaderboard/route");
  const response = await GET(new Request(`https://pixelwar.fun/api/leaderboard?war=${slug}`));
  expect(response.status).toBe(200);
  return (await response.json()) as {
    tokens: Array<{ id: string; logoUrl: string | null; owned: number; net: number | null }>;
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
    // Where they stood before the window opened, and where they stand now:
    // blue has taken forty pixels off red.
    for (const [token, then, now] of [
      [red, 100, 60],
      [blue, 20, 60],
    ] as const) {
      await execute(
        `INSERT INTO token_pixel_snapshots (war_id, war_token_id, owned, taken_at)
         VALUES ($1, $2, $3, now() - ($4 || ' minutes')::interval)`,
        [war.id, token, then, String(MOMENTUM_MINUTES + 2)],
      );
      await execute(`UPDATE token_pixel_counts SET owned = $3 WHERE war_id = $1 AND war_token_id = $2`,
        [war.id, token, now]);
    }

    const byId = new Map((await leaderboard(war.slug)).tokens.map((t) => [t.id, t]));
    expect(byId.get(red)?.net).toBe(-40);
    expect(byId.get(blue)?.net).toBe(40);
  });

  it("takes the snapshot that the next ten minutes will be measured against", { timeout: 30_000 }, async () => {
    // THE WRITE, and nothing else in the application performs it. Without
    // this the feature works until the snapshots on disk age out, then goes
    // quiet with no error anywhere.
    expect(
      Number(
        (await queryOne<{ n: string }>(
          `SELECT count(*) AS n FROM token_pixel_snapshots WHERE war_id = $1`,
          [war.id],
        ))?.n,
      ),
    ).toBe(0);

    await leaderboard(war.slug);

    const after = await queryOne<{ n: string }>(
      `SELECT count(*) AS n FROM token_pixel_snapshots WHERE war_id = $1`,
      [war.id],
    );
    expect(Number(after?.n)).toBe(2);
  });

  it("carries a token's logo on every poll, not only the first render", { timeout: 30_000 }, async () => {
    const byId = new Map((await leaderboard(war.slug)).tokens.map((t) => [t.id, t]));
    expect(byId.get(red)?.logoUrl).toBe(LOGO);
    // Null rather than absent: the client renders nothing for it, and a
    // missing key would be indistinguishable from the column being dropped.
    expect(byId.get(blue)?.logoUrl).toBeNull();
  });

  it("says null, not zero, when there is nothing to compare against", { timeout: 30_000 }, async () => {
    // A war whose first poll this is has no ten-minute-old snapshot. Zero
    // would be a claim that nothing is happening; null renders nothing and
    // the number appears once there is one.
    for (const token of (await leaderboard(war.slug)).tokens) {
      expect(token.net).toBeNull();
    }
  });
});

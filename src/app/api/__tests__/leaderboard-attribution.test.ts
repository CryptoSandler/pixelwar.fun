import { describe, expect, it } from "vitest";
import { makeToken, makeWar } from "../../../lib/canvas/__tests__/fixtures";
import { paintPixel } from "../../../lib/paint/paint";

/**
 * The leaderboard counts TOKENS, not COLOURS.
 *
 * It always did — `token_pixel_counts` is keyed `(war_id, war_token_id)` and
 * has no colour column anywhere near it. That was invisible while a token's
 * colour and a token's identity were the same number, and it is the reason
 * the free-palette change needed no leaderboard change at all.
 *
 * "No change was needed" is a claim, though, and an untested claim about a
 * scoreboard is how a scoreboard starts lying. These tests make the two facts
 * disagree on purpose — a token painting in somebody else's flag colour, two
 * tokens painting in the SAME colour — and assert the counts still follow the
 * painter. Under the old model none of these situations could be expressed;
 * under the new one they are ordinary, and the leaderboard has to survive
 * them.
 */

const KEYS = { painterKey: "painter-a", ipHash: "ip-a", subnetKey: "subnet-a" };

async function leaderboard(slug: string) {
  const { GET } = await import("../leaderboard/route");
  const response = await GET(new Request(`https://pixelwar.fun/api/leaderboard?war=${slug}`));
  return (await response.json()) as {
    tokens: Array<{ id: string; colourSlot: number; owned: number; placed: number }>;
  };
}

describe("leaderboard attribution under a free palette", () => {
  it(
    "credits the painting token, not the token whose flag colour was used",
    { timeout: 30_000 },
    async () => {
      const war = await makeWar({ width: 8, height: 8 });
      const alpha = await makeToken(war.id, 3);
      const beta = await makeToken(war.id, 9);

      // Alpha paints in BETA's flag colour. Under the old model this was not
      // a thing that could happen; the pixel would have been beta's.
      const painted = await paintPixel({
        war,
        x: 0,
        y: 0,
        tokenId: alpha,
        colourSlot: 9,
        ...KEYS,
      });
      expect(painted).toMatchObject({ ok: true, colourSlot: 9 });

      const { tokens } = await leaderboard(war.slug);
      const byId = Object.fromEntries(tokens.map((t) => [t.id, t]));

      expect(byId[alpha]).toMatchObject({ owned: 1, placed: 1 });
      expect(byId[beta]).toMatchObject({ owned: 0, placed: 0 });
    },
  );

  it(
    "keeps two tokens apart even when they paint the identical colour",
    { timeout: 30_000 },
    async () => {
      const war = await makeWar({ width: 8, height: 8 });
      const alpha = await makeToken(war.id, 3);
      const beta = await makeToken(war.id, 9);

      // Same colour, different painters, different pixels. On the painted
      // board these are indistinguishable — that is the product decision. The
      // scoreboard is the surface that still has to tell them apart.
      await paintPixel({ war, x: 0, y: 0, tokenId: alpha, colourSlot: 20, ...KEYS });
      await paintPixel({
        war,
        x: 1,
        y: 0,
        tokenId: beta,
        colourSlot: 20,
        painterKey: "painter-b",
        ipHash: "ip-b",
        subnetKey: "subnet-b",
      });

      const { tokens } = await leaderboard(war.slug);
      const byId = Object.fromEntries(tokens.map((t) => [t.id, t]));

      expect(byId[alpha]).toMatchObject({ owned: 1, placed: 1 });
      expect(byId[beta]).toMatchObject({ owned: 1, placed: 1 });
    },
  );

  it(
    "moves ownership when a pixel is overpainted by another token in any colour",
    { timeout: 30_000 },
    async () => {
      const war = await makeWar({ width: 8, height: 8 });
      const alpha = await makeToken(war.id, 3);
      const beta = await makeToken(war.id, 9);

      await paintPixel({ war, x: 4, y: 4, tokenId: alpha, colourSlot: 1, ...KEYS });
      // Beta takes the same pixel, in a third colour belonging to neither.
      await paintPixel({
        war,
        x: 4,
        y: 4,
        tokenId: beta,
        colourSlot: 15,
        painterKey: "painter-b",
        ipHash: "ip-b",
        subnetKey: "subnet-b",
      });

      const { tokens } = await leaderboard(war.slug);
      const byId = Object.fromEntries(tokens.map((t) => [t.id, t]));

      // `owned` follows the board; `placed` is a lifetime tally and does not
      // go back down when somebody paints over you.
      expect(byId[alpha]).toMatchObject({ owned: 0, placed: 1 });
      expect(byId[beta]).toMatchObject({ owned: 1, placed: 1 });
    },
  );
});

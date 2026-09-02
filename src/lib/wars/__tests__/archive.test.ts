import { describe, expect, it } from "vitest";
import { makeToken, makeWar, paintRaw } from "../../canvas/__tests__/fixtures";
import { execute } from "../../db";
import {
  finalStandings,
  paintedTotal,
  shareOfBoard,
  winnersFor,
  winnerOf,
} from "../archive";
import { finishedWars, lastFinishedWar } from "../lifecycle";

/**
 * The result of a war, which is the one number this product exists to
 * produce.
 *
 * `paintRaw` writes pixels and deliberately does NOT touch
 * `token_pixel_counts` — that table is maintained by `paintPixel`, and a
 * fixture that updated it would be arranging the world through the code under
 * test. So the counts are set here, explicitly, which also means these tests
 * can express a board state the painting rules would take a long time to
 * reach.
 */
async function hold(warId: string, tokenId: string, owned: number, placed = owned) {
  await execute(
    `UPDATE token_pixel_counts SET owned = $3, placed = $4 WHERE war_id = $1 AND war_token_id = $2`,
    [warId, tokenId, owned, placed],
  );
}

async function endWar(warId: string) {
  await execute(
    `UPDATE wars SET status = 'ended', ended_at = now(), ends_at = now() WHERE id = $1`,
    [warId],
  );
}

describe("finalStandings", () => {
  it("ranks by pixels HELD, not by pixels placed", { timeout: 30_000 }, async () => {
    const war = await makeWar({ width: 100, height: 100 });
    const grinder = await makeToken(war.id, 3);
    const holder = await makeToken(war.id, 7);
    await paintRaw(war.id, 0, grinder, 5, 1);

    // The grinder placed far more and holds far less: it was overpainted all
    // war. DESIGN.md §8 says the leaderboard counts pixels held and never
    // pixels placed, and a ranking sorted the other way would make that copy
    // a lie.
    await hold(war.id, grinder, 40, 4_000);
    await hold(war.id, holder, 900, 900);

    const standings = await finalStandings(war.id);
    expect(standings.map((s) => s.ticker)).toEqual(["T7", "T3"]);
    expect(standings[1].placed).toBe(4_000);
  });

  it("keeps a token that held nothing", { timeout: 30_000 }, async () => {
    const war = await makeWar({ width: 100, height: 100 });
    const winner = await makeToken(war.id, 3);
    await makeToken(war.id, 9);
    await hold(war.id, winner, 12);

    // A community that paid its admission and got wiped off the board still
    // entered the war. Zero is a result; absence would disagree with the
    // receipt.
    const standings = await finalStandings(war.id);
    expect(standings).toHaveLength(2);
    expect(standings[1].owned).toBe(0);
  });

  it("breaks a tie the same way on every render", { timeout: 30_000 }, async () => {
    const war = await makeWar({ width: 100, height: 100 });
    const early = await makeToken(war.id, 2);
    const late = await makeToken(war.id, 19);
    await hold(war.id, early, 50);
    await hold(war.id, late, 50);

    // Without the secondary sort Postgres is free to reorder equal rows
    // between two identical queries, and the ranking would shuffle on reload
    // for no reason a reader could see.
    for (let attempt = 0; attempt < 3; attempt++) {
      const standings = await finalStandings(war.id);
      expect(standings.map((s) => s.ticker)).toEqual(["T2", "T19"]);
    }
    expect(winnerOf(await finalStandings(war.id))?.ticker).toBe("T2");
  });
});

describe("winnerOf", () => {
  it("is null on a board nobody holds, rather than a zero", { timeout: 30_000 }, async () => {
    const war = await makeWar({ width: 100, height: 100 });
    await makeToken(war.id, 3);
    await makeToken(war.id, 4);

    // "T3 took the board with 0 pixels" is a headline about nothing. The
    // screens above this decide what to say instead.
    expect(winnerOf(await finalStandings(war.id))).toBeNull();
  });

  it("is null on a war nobody entered", () => {
    expect(winnerOf([])).toBeNull();
  });
});

describe("winnersFor", () => {
  it("answers for many wars in one query, and omits the ones with no winner", { timeout: 30_000 }, async () => {
    const won = await makeWar({ width: 100, height: 100 });
    const champion = await makeToken(won.id, 5);
    await hold(won.id, champion, 300);

    const blank = await makeWar({ width: 100, height: 100 });
    await makeToken(blank.id, 6);

    const winners = await winnersFor([won.id, blank.id]);
    expect(winners.get(won.id)).toEqual({ ticker: "T5", colourSlot: 5, owned: 300 });

    // ABSENT, NOT PRESENT-WITH-ZERO. `owned > 0` sits in the query so that a
    // war with nothing held comes back missing from the map, which the caller
    // reads as "no winner" — the same distinction `winnerOf` makes.
    expect(winners.has(blank.id)).toBe(false);
  });

  it("costs nothing on an empty archive", async () => {
    expect(await winnersFor([])).toEqual(new Map());
  });
});

describe("the archive and the intermission agree about what finished", () => {
  it("lists a war that ended with pixels on it", { timeout: 30_000 }, async () => {
    const war = await makeWar({ width: 100, height: 100 });
    const token = await makeToken(war.id, 3);
    await paintRaw(war.id, 0, token, 5, 1);
    await endWar(war.id);

    expect((await finishedWars()).map((w) => w.id)).toContain(war.id);
  });

  /**
   * The policy that keeps a fixture off the front page, asserted rather than
   * trusted. Two wars titled "Fixture war" have been found in this project's
   * PRODUCTION database; the reason nobody saw them for days is that nothing
   * read finished wars yet. Now three screens do.
   */
  it("hides a war that ended with an empty board", { timeout: 30_000 }, async () => {
    const war = await makeWar({ width: 100, height: 100 });
    await makeToken(war.id, 3);
    await endWar(war.id);

    expect((await finishedWars()).map((w) => w.id)).not.toContain(war.id);
  });

  it("hides a war that is still live", { timeout: 30_000 }, async () => {
    const war = await makeWar({ width: 100, height: 100 });
    const token = await makeToken(war.id, 3);
    await paintRaw(war.id, 0, token, 5, 1);

    expect((await finishedWars()).map((w) => w.id)).not.toContain(war.id);
  });

  /**
   * THE ANTI-DRIFT ASSERTION, and it is the reason `lastFinishedWar` was
   * rewritten to delegate. Two copies of a predicate with a policy inside it
   * both keep answering *something*, and only one of them stays right.
   */
  it("puts the same war at the top of the archive as on the front page", { timeout: 30_000 }, async () => {
    const older = await makeWar({ width: 100, height: 100 });
    const olderToken = await makeToken(older.id, 3);
    await paintRaw(older.id, 0, olderToken, 5, 1);
    await endWar(older.id);

    const newer = await makeWar({ width: 100, height: 100 });
    const newerToken = await makeToken(newer.id, 4);
    await paintRaw(newer.id, 0, newerToken, 6, 1);
    await endWar(newer.id);

    const archive = await finishedWars();
    expect(archive[0].id).toBe((await lastFinishedWar())!.id);
    expect(archive[0].id).toBe(newer.id);
  });
});

describe("the numbers on the page", () => {
  it("states a share of the BOARD, not of the painted area", () => {
    // "62% of the pixels that were painted" is a statistic about the other
    // tokens; "12% of the board" is a statistic about the war.
    expect(shareOfBoard(4_000, { width: 200, height: 200 })).toBeCloseTo(10);
    expect(shareOfBoard(0, { width: 200, height: 200 })).toBe(0);
  });

  it("adds up what is held, not what was placed", () => {
    const standings = [
      { warTokenId: "a", ticker: "A", name: "A", colourSlot: 1, logoUrl: null, owned: 10, placed: 900 },
      { warTokenId: "b", ticker: "B", name: "B", colourSlot: 2, logoUrl: null, owned: 5, placed: 900 },
    ];
    expect(paintedTotal(standings)).toBe(15);
  });
});

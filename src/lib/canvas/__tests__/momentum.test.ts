import { describe, expect, it } from "vitest";
import { execute, queryOne } from "../../db";
import { makeToken, makeWar } from "./fixtures";
import {
  MOMENTUM_MAX_SNAPSHOT_MINUTES,
  MOMENTUM_MINUTES,
  SNAPSHOT_RETENTION_HOURS,
  pruneTokenSnapshots,
  snapshotTokenCounts,
  territoryMomentum,
} from "../momentum";

/**
 * The signal that tells a community it is being taken apart right now.
 *
 * THESE TESTS EXIST IN THE SHAPE THEY DO BECAUSE THE FIRST ONES DID NOT.
 * Momentum was first derived from `pixel_events` with a window function, and
 * six tests passed — every one of them putting both paints inside the
 * ten-minute window, which is the only regime where that query works. A raid
 * overpaints ground claimed HOURS ago, and against a seeded board where 216
 * pixels changed hands the signal reported zero losses for anybody. The tests
 * were not wrong about what they asserted; they were all drawn from the same
 * corner of the space.
 *
 * So the first case below is the raid, written from the outside: "somebody
 * held ground, somebody took it, hours apart". It does not mention how the
 * arithmetic works, which is the point — it would have failed the old
 * implementation and passes this one.
 *
 * Counts and snapshots are written by hand rather than by painting, because
 * what is under test is a difference over time, and a paint path cannot
 * produce a ten-minute-old row inside a test.
 */

/** Sets what a token holds now, as the paint path would leave it. */
async function holds(warId: string, tokenId: string, owned: number, moderated = 0) {
  await execute(
    `UPDATE token_pixel_counts SET owned = $3, removed_by_moderation = $4
      WHERE war_id = $1 AND war_token_id = $2`,
    [warId, tokenId, owned, moderated],
  );
}

/** Records where a token stood, `minutesAgo` minutes ago. */
async function stood(
  warId: string,
  tokenId: string,
  owned: number,
  minutesAgo: number,
  moderated = 0,
) {
  await execute(
    `INSERT INTO token_pixel_snapshots (war_id, war_token_id, owned, removed_by_moderation, taken_at)
     VALUES ($1, $2, $3, $5, now() - ($4 || ' minutes')::interval)`,
    [warId, tokenId, owned, String(minutesAgo), moderated],
  );
}

describe("a raid on ground claimed hours ago", () => {
  it("charges the holder the loss and credits the raider", { timeout: 20_000 }, async () => {
    const war = await makeWar();
    const red = await makeToken(war.id, 1);
    const blue = await makeToken(war.id, 2);

    // Red took this ground long before the window opened and has not touched
    // it since. This is the case the event-log implementation could not see.
    await stood(war.id, red, 500, MOMENTUM_MINUTES + 2);
    await stood(war.id, blue, 100, MOMENTUM_MINUTES + 2);

    await holds(war.id, red, 332);
    await holds(war.id, blue, 268);

    const momentum = await territoryMomentum(war.id);
    expect(momentum.get(red)).toMatchObject({ net: -168 });
    expect(momentum.get(blue)).toMatchObject({ net: 168 });
  });

  it("counts a token retouching its own old art as neither", { timeout: 20_000 }, async () => {
    // Repainting cells you already hold does not change `owned`, so this
    // falls out of the design rather than needing a rule. The old
    // implementation credited it as a gain, because a paint with no previous
    // owner inside the window looked like taking ground.
    const war = await makeWar();
    const red = await makeToken(war.id, 1);

    await stood(war.id, red, 500, MOMENTUM_MINUTES + 2);
    await holds(war.id, red, 500);

    expect(momentumOf(await territoryMomentum(war.id), red)).toMatchObject({ net: 0 });
  });
});

describe("what the signal refuses to say", () => {
  it("omits a token with no snapshot old enough to compare against", { timeout: 20_000 }, async () => {
    const war = await makeWar();
    const red = await makeToken(war.id, 1);

    // Taken a minute ago: inside the window, so it cannot answer "what
    // changed over the last ten minutes".
    await stood(war.id, red, 500, 1);
    await holds(war.id, red, 600);

    expect(await territoryMomentum(war.id)).toEqual(new Map());
  });

  it("omits a token whose newest usable snapshot is stale", { timeout: 20_000 }, async () => {
    // A war nobody has watched for an hour. Diffing against that and calling
    // it "the last ten minutes" would be the application lying about itself,
    // and a wrong number nobody can detect is worse than no number.
    const war = await makeWar();
    const red = await makeToken(war.id, 1);

    await stood(war.id, red, 500, MOMENTUM_MAX_SNAPSHOT_MINUTES + 5);
    await holds(war.id, red, 100);

    expect(await territoryMomentum(war.id)).toEqual(new Map());
  });

  it("reads the newest snapshot in range, not the oldest", { timeout: 20_000 }, async () => {
    const war = await makeWar();
    const red = await makeToken(war.id, 1);

    await stood(war.id, red, 100, MOMENTUM_MAX_SNAPSHOT_MINUTES - 1);
    await stood(war.id, red, 400, MOMENTUM_MINUTES + 1); // the one it must use
    await holds(war.id, red, 450);

    expect(momentumOf(await territoryMomentum(war.id), red)).toMatchObject({ net: 50 });
  });

  it("reports nothing at all for a war nobody has painted", { timeout: 20_000 }, async () => {
    const war = await makeWar();
    await makeToken(war.id, 1);
    expect(await territoryMomentum(war.id)).toEqual(new Map());
  });
});

describe("moderation is not somebody losing a fight", () => {
  it("does not charge a token for pixels a moderator cleared", { timeout: 20_000 }, async () => {
    // Ten of red's pixels were vandalism and were reverted. `owned` fell by
    // ten, and without the moderation counter this would read as red losing
    // ground to a rival — which also puts a moderator's action on a public
    // scoreboard.
    const war = await makeWar();
    const red = await makeToken(war.id, 1);

    await stood(war.id, red, 500, MOMENTUM_MINUTES + 2, 0);
    await holds(war.id, red, 490, 10);

    expect(momentumOf(await territoryMomentum(war.id), red)).toMatchObject({ net: 0 });
  });

  it("still reports real ground lost in the same interval", { timeout: 20_000 }, async () => {
    // Moderation took 10 and a rival took 40. Only the 40 is a defeat.
    const war = await makeWar();
    const red = await makeToken(war.id, 1);

    await stood(war.id, red, 500, MOMENTUM_MINUTES + 2, 0);
    await holds(war.id, red, 450, 10);

    expect(momentumOf(await territoryMomentum(war.id), red)).toMatchObject({ net: -40 });
  });
});

describe("taking the snapshot", () => {
  it("records every token in the war", { timeout: 20_000 }, async () => {
    const war = await makeWar();
    const red = await makeToken(war.id, 1);
    const blue = await makeToken(war.id, 2);
    await holds(war.id, red, 12);
    await holds(war.id, blue, 7);

    await snapshotTokenCounts(war.id);

    const rows = await queryOne<{ n: string; total: string }>(
      `SELECT count(*) AS n, sum(owned) AS total FROM token_pixel_snapshots WHERE war_id = $1`,
      [war.id],
    );
    expect(Number(rows?.n)).toBe(2);
    expect(Number(rows?.total)).toBe(19);
  });

  it("writes at most one round per minute, however often it is called", { timeout: 20_000 }, async () => {
    // The leaderboard polls every two seconds. Without the guard a busy war
    // would write 24 rows every two seconds, forever.
    const war = await makeWar();
    await makeToken(war.id, 1);

    await snapshotTokenCounts(war.id);
    await snapshotTokenCounts(war.id);
    await snapshotTokenCounts(war.id);

    const row = await queryOne<{ n: string }>(
      `SELECT count(*) AS n FROM token_pixel_snapshots WHERE war_id = $1`,
      [war.id],
    );
    expect(Number(row?.n)).toBe(1);
  });

  it("keeps one war's snapshots from suppressing another's", { timeout: 20_000 }, async () => {
    // The guard is per war. Two wars run at once and each needs its own
    // resolution; a global "one a minute" would starve whichever polled second.
    const a = await makeWar();
    const b = await makeWar();
    await makeToken(a.id, 1);
    await makeToken(b.id, 1);

    await snapshotTokenCounts(a.id);
    await snapshotTokenCounts(b.id);

    for (const war of [a, b]) {
      const row = await queryOne<{ n: string }>(
        `SELECT count(*) AS n FROM token_pixel_snapshots WHERE war_id = $1`,
        [war.id],
      );
      expect(Number(row?.n), `war ${war.slug} took no snapshot`).toBe(1);
    }
  });
});

describe("sweeping snapshots", () => {
  it("drops what nothing can read and keeps what something can", { timeout: 20_000 }, async () => {
    const war = await makeWar();
    const red = await makeToken(war.id, 1);

    await stood(war.id, red, 1, SNAPSHOT_RETENTION_HOURS * 60 + 30);
    await stood(war.id, red, 2, MOMENTUM_MINUTES + 1);

    await pruneTokenSnapshots();

    const row = await queryOne<{ n: string }>(
      `SELECT count(*) AS n FROM token_pixel_snapshots WHERE war_id = $1`,
      [war.id],
    );
    expect(Number(row?.n)).toBe(1);
  });
});

function momentumOf(map: Awaited<ReturnType<typeof territoryMomentum>>, token: string) {
  const entry = map.get(token);
  if (!entry) throw new Error(`no momentum recorded for ${token}`);
  return entry;
}

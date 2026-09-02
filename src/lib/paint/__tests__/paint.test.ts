import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import { execute, query } from "../../db";
import { warById } from "../../wars/lifecycle";
import { makeToken, makeWar, registerPainter } from "../../canvas/__tests__/fixtures";
import { paintPixel } from "../paint";

/**
 * Every painter these tests use, registered before each one.
 *
 * Painting has needed a registered wallet since migration 012, and these are
 * unit tests of everything EXCEPT that gate — so the world they arrange is
 * one where the gate is satisfied. A key missing from this list fails loudly
 * with `not_registered` rather than quietly passing.
 */
const PAINTERS = ["a-brand-new-painter", "painter-a", "painter-b"];

beforeEach(async () => {
  for (const key of PAINTERS) await registerPainter(key);
});


/**
 * The painter's identity keys, plus a colour to paint in.
 *
 * `colourSlot` lives here because almost every test below cares about the
 * cooldown, the sequence or the counts rather than about which colour landed
 * — and since the free-palette change the colour is an independent input that
 * every call has to supply. It is deliberately NOT the same number as the
 * token colour these tests use (5), so a test that passes only because those
 * two happen to coincide cannot hide here.
 */
const PAINT_COLOUR = 12;
const KEYS = {
  painterKey: "painter-a",
  ipHash: "ip-a",
  subnetKey: "subnet-a",
  colourSlot: PAINT_COLOUR,
};

beforeEach(() => {
  process.env.RATE_LIMIT_SALT = "test-salt";
});

describe("paintPixel", () => {
  // Creating a war, creating a token, and painting are each their own
  // sequential round trips to a remote Neon database, and several tests
  // below add more paints or extra queries on top -- comfortably close
  // enough to the suite's 5000ms default to fail intermittently on a
  // slower hop. This and the other slow tests in the file get their own
  // ceiling rather than raising the suite default for everything in it.
  it("paints, allocates sequence 1, and reports the cooldown", { timeout: 20_000 }, async () => {
    const war = await makeWar({ width: 100, height: 100, cooldownSeconds: 30 });
    const token = await makeToken(war.id, 5);

    const result = await paintPixel({ war, x: 2, y: 3, tokenId: token, ...KEYS });

    // `idx` is `y * width + x`; 26 was that arithmetic done against the
    // fixture's old 8-wide board and frozen as a literal.
    expect(result).toMatchObject({
      ok: true, seq: 1, idx: 3 * war.width + 2, colourSlot: PAINT_COLOUR,
    });
    if (!result.ok) throw new Error("unreachable");
    expect(Date.parse(result.cooldownUntil)).toBeGreaterThan(Date.now());
  });

  it("records the pixel, the event, and the count together", { timeout: 20_000 }, async () => {
    const war = await makeWar({ width: 100, height: 100 });
    const token = await makeToken(war.id, 5);
    await paintPixel({ war, x: 0, y: 0, tokenId: token, ...KEYS });

    const [pixel] = await query<{ idx: number; seq: string }>(`SELECT idx, seq FROM pixels`);
    const [event] = await query<{ idx: number; colour_slot: number }>(
      `SELECT idx, colour_slot FROM pixel_events`,
    );
    const [count] = await query<{ owned: number; placed: number }>(
      `SELECT owned, placed FROM token_pixel_counts`,
    );

    expect(pixel).toMatchObject({ idx: 0 });
    expect(event).toMatchObject({ idx: 0, colour_slot: PAINT_COLOUR });
    expect(count).toEqual({ owned: 1, placed: 1 });
  });

  it("moves ownership when one token paints over another", { timeout: 20_000 }, async () => {
    const war = await makeWar({ width: 100, height: 100 });
    const red = await makeToken(war.id, 1);
    const blue = await makeToken(war.id, 13);

    await paintPixel({ war, x: 1, y: 1, tokenId: red, ...KEYS });
    await paintPixel({
      colourSlot: PAINT_COLOUR,
      war: (await warById(war.id))!,
      x: 1,
      y: 1,
      tokenId: blue,
      painterKey: "painter-b",
      ipHash: "ip-b",
      subnetKey: "subnet-b",
    });

    const counts = await query<{ war_token_id: string; owned: number; placed: number }>(
      `SELECT war_token_id, owned, placed FROM token_pixel_counts ORDER BY war_token_id`,
    );
    const byToken = Object.fromEntries(counts.map((c) => [c.war_token_id, c]));
    expect(byToken[red].owned).toBe(0);
    expect(byToken[red].placed).toBe(1);
    expect(byToken[blue].owned).toBe(1);
  });

  it(
    "refuses a second paint from the same painter inside the cooldown",
    { timeout: 20_000 },
    async () => {
      const war = await makeWar({ cooldownSeconds: 30 });
      const token = await makeToken(war.id, 5);

      await paintPixel({ war, x: 0, y: 0, tokenId: token, ...KEYS });
      const second = await paintPixel({ war, x: 1, y: 0, tokenId: token, ...KEYS });

      expect(second).toMatchObject({ ok: false, reason: "cooldown" });
      if (second.ok) throw new Error("unreachable");
      expect(second.retryAfterSeconds).toBeGreaterThan(0);
      expect(await query(`SELECT 1 FROM pixels`)).toHaveLength(1);
    },
  );

  it(
    "still blocks when the cookie is cleared but the address is the same",
    { timeout: 20_000 },
    async () => {
      const war = await makeWar({ cooldownSeconds: 30 });
      const token = await makeToken(war.id, 5);

      await paintPixel({ war, x: 0, y: 0, tokenId: token, ...KEYS });
      const second = await paintPixel({
        colourSlot: PAINT_COLOUR,
        war,
        x: 1,
        y: 0,
        tokenId: token,
        painterKey: "a-brand-new-painter",
        ipHash: KEYS.ipHash,
        subnetKey: KEYS.subnetKey,
      });

      expect(second).toMatchObject({ ok: false, reason: "cooldown" });
    },
  );

  it(
    "still blocks when the address changes but the cookie is the same",
    { timeout: 20_000 },
    async () => {
      const war = await makeWar({ cooldownSeconds: 30 });
      const token = await makeToken(war.id, 5);

      await paintPixel({ war, x: 0, y: 0, tokenId: token, ...KEYS });
      const second = await paintPixel({
        colourSlot: PAINT_COLOUR,
        war,
        x: 1,
        y: 0,
        tokenId: token,
        painterKey: KEYS.painterKey,
        ipHash: "a-different-address",
        subnetKey: "a-different-subnet",
      });

      expect(second).toMatchObject({ ok: false, reason: "cooldown" });
    },
  );

  it(
    "lets exactly one of two simultaneous paints from one painter through",
    { timeout: 20_000 },
    async () => {
      const war = await makeWar({ cooldownSeconds: 30 });
      const token = await makeToken(war.id, 5);

      const results = await Promise.all([
        paintPixel({ war, x: 0, y: 0, tokenId: token, ...KEYS }),
        paintPixel({ war, x: 1, y: 0, tokenId: token, ...KEYS }),
      ]);

      expect(results.filter((r) => r.ok)).toHaveLength(1);
      expect(await query(`SELECT 1 FROM pixels`)).toHaveLength(1);
    },
  );

  it("hands out a gapless sequence under concurrency", { timeout: 20_000 }, async () => {
    const war = await makeWar({ width: 100, height: 100 });
    const token = await makeToken(war.id, 5);

    // The eight painters below are made up on the spot, so they are not in
    // PAINTERS and have to be registered here.
    for (let i = 0; i < 8; i++) await registerPainter(`painter-${i}`);

    // Eight, not twenty: the pool is ten clients and every paint holds one for
    // the length of a transaction that serialises on the wars row. Twenty
    // concurrent callers starve the pool and fail on pg's own connect timeout,
    // which no vitest timeout can rescue — a flaky test measuring the pool
    // instead of the property. Eight still races the same allocation.
    await Promise.all(
      Array.from({ length: 8 }, (_, i) =>
        paintPixel({
          colourSlot: PAINT_COLOUR,
          war,
          x: i,
          y: 0,
          tokenId: token,
          painterKey: `painter-${i}`,
          ipHash: `ip-${i}`,
          subnetKey: `subnet-${i}`,
        }),
      ),
    );

    const rows = await query<{ seq: string }>(`SELECT seq FROM pixel_events ORDER BY seq`);
    expect(rows.map((r) => Number(r.seq))).toEqual(Array.from({ length: 8 }, (_, i) => i + 1));
  });

  it("refuses a token that belongs to another war", async () => {
    const war = await makeWar();
    const other = await makeWar();
    const foreign = await makeToken(other.id, 5);

    const result = await paintPixel({ war, x: 0, y: 0, tokenId: foreign, ...KEYS });
    expect(result).toMatchObject({ ok: false, reason: "unknown_token" });
  });

  it("refuses a token that has reserved a colour but not paid", async () => {
    const war = await makeWar();
    const token = await makeToken(war.id, 5);
    await execute(`UPDATE war_tokens SET status = 'reserved' WHERE id = $1`, [token]);

    const result = await paintPixel({ war, x: 0, y: 0, tokenId: token, ...KEYS });
    expect(result).toMatchObject({ ok: false, reason: "unknown_token" });
  });

  it("refuses coordinates outside the board", async () => {
    const war = await makeWar({ width: 100, height: 100 });
    const token = await makeToken(war.id, 5);

    // The off-board coordinates are the war's own edges, not the literals 8
    // and 8 — which were the fixture's old width written out again, and which
    // became perfectly valid pixels the moment the board grew.
    for (const [x, y] of [
      [-1, 0], [0, -1], [war.width, 0], [0, war.height], [1.5, 0],
    ]) {
      const result = await paintPixel({ war, x, y, tokenId: token, ...KEYS });
      expect(result).toMatchObject({ ok: false, reason: "out_of_bounds" });
    }
  });

  it("refuses to paint on a war that has already ended", async () => {
    const war = await makeWar({
      status: "ended",
      startsAt: new Date(Date.now() - 7_200_000),
      endsAt: new Date(Date.now() - 3_600_000),
    });
    const token = await makeToken(war.id, 5);

    const result = await paintPixel({ war, x: 0, y: 0, tokenId: token, ...KEYS });
    expect(result).toMatchObject({ ok: false, reason: "war_not_live" });
  });

  it("refuses to paint on a war that has not started yet, distinctly from one that has ended", async () => {
    const war = await makeWar({
      status: "scheduled",
      startsAt: new Date(Date.now() + 3_600_000),
      endsAt: new Date(Date.now() + 7_200_000),
    });
    const token = await makeToken(war.id, 5);

    const result = await paintPixel({ war, x: 0, y: 0, tokenId: token, ...KEYS });
    expect(result).toMatchObject({ ok: false, reason: "war_not_started" });
  });

  it("refuses a banned painter, and leaves no trace of the attempt", async () => {
    const war = await makeWar();
    const token = await makeToken(war.id, 5);
    await execute(
      `INSERT INTO bans (id, key_type, key, actor) VALUES ($1, 'painter', $2, 'test')`,
      [randomUUID(), KEYS.painterKey],
    );

    const result = await paintPixel({ war, x: 0, y: 0, tokenId: token, ...KEYS });
    expect(result).toMatchObject({ ok: false, reason: "banned" });
    expect(await query(`SELECT 1 FROM pixels`)).toHaveLength(0);
    // A ban must not burn the cooldown row either; nothing about a banned
    // caller should be recorded per attempt.
    expect(await query(`SELECT 1 FROM paint_cooldowns`)).toHaveLength(0);
  });

  it("ignores a ban that has already expired", { timeout: 20_000 }, async () => {
    const war = await makeWar();
    const token = await makeToken(war.id, 5);
    await execute(
      `INSERT INTO bans (id, key_type, key, actor, expires_at)
       VALUES ($1, 'painter', $2, 'test', now() - interval '1 hour')`,
      [randomUUID(), KEYS.painterKey],
    );

    expect(await paintPixel({ war, x: 0, y: 0, tokenId: token, ...KEYS })).toMatchObject({
      ok: true,
    });
  });

  it(
    "caps a subnet's burst even when every painter behind it is new",
    { timeout: 20_000 },
    async () => {
      // Snapshot and restore in a finally rather than deleting at the end of
      // the test body: the suite is single-fork, so one failed assertion
      // above would otherwise leave a burst cap of 3 in place for every test
      // in every file that runs afterwards.
      const previousBurst = process.env.PAINT_SUBNET_BURST;
      const previousWindow = process.env.PAINT_SUBNET_WINDOW_SECONDS;
      process.env.PAINT_SUBNET_BURST = "3";
      // Clearly larger than the war's cooldown below, so a wait reported from
      // the wrong clock (the painter's cooldown) is unmistakable from a wait
      // reported from the right one (the rest of this window).
      process.env.PAINT_SUBNET_WINDOW_SECONDS = "120";

      try {
        const war = await makeWar({ width: 100, height: 100, cooldownSeconds: 5 });
        const token = await makeToken(war.id, 5);

        for (let i = 0; i < 5; i++) await registerPainter(`painter-${i}`);

        const results = [];
        for (let i = 0; i < 5; i++) {
          results.push(
            await paintPixel({
              colourSlot: PAINT_COLOUR,
              war,
              x: i,
              y: 0,
              tokenId: token,
              painterKey: `painter-${i}`,
              ipHash: `ip-${i}`,
              subnetKey: "one-shared-subnet",
            }),
          );
        }

        expect(results.filter((r) => r.ok)).toHaveLength(3);
        expect(results[4]).toMatchObject({ ok: false, reason: "cooldown" });

        // The wait must be the window's, not one painter's cooldown. Reporting the
        // painter's number here tells a caller behind a capped subnet to come back
        // in seconds when the real block lasts the rest of the window.
        const refused = results[4];
        if (refused.ok) throw new Error("unreachable");
        expect(refused.retryAfterSeconds).toBeGreaterThan(war.cooldownSeconds);
      } finally {
        if (previousBurst === undefined) delete process.env.PAINT_SUBNET_BURST;
        else process.env.PAINT_SUBNET_BURST = previousBurst;
        if (previousWindow === undefined) delete process.env.PAINT_SUBNET_WINDOW_SECONDS;
        else process.env.PAINT_SUBNET_WINDOW_SECONDS = previousWindow;
      }
    },
  );
});

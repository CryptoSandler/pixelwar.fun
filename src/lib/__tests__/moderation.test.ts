import { beforeEach, describe, expect, it } from "vitest";
import { makeToken, makeWar, paintRaw, registerPainter } from "../canvas/__tests__/fixtures";
import { execute, pool, query, queryOne } from "../db";
import { isBanned } from "../paint/bans";
import {
  banKey,
  endWarNow,
  inspectPixel,
  liftBan,
  listBans,
  MAX_REVERT_CELLS,
  revertRegion,
} from "../moderation";
import { paintPixel } from "../paint/paint";
import { warById } from "../wars/lifecycle";

/**
 * Every painter these tests use, registered before each one.
 *
 * Painting has needed a registered wallet since migration 012, and these are
 * unit tests of everything EXCEPT that gate — so the world they arrange is
 * one where the gate is satisfied. A key missing from this list fails loudly
 * with `not_registered` rather than quietly passing.
 */
const PAINTERS = ["other", "painter-mod", "x"];

beforeEach(async () => {
  for (const key of PAINTERS) await registerPainter(key);
});


/**
 * Moderation, which is the only part of the launch plan that cannot be added
 * late.
 *
 * The mechanism was already here — `bans` since migration 001, `isBanned`
 * consulted by `paintPixel` before it writes anything. What these tests prove
 * is that the operator can now reach it, and that the three destructive
 * actions do what they claim: a ban actually stops a paint, a revert actually
 * clears cells without corrupting the sequence clients depend on, and the
 * kill switch actually stops the war.
 */

const KEYS = { painterKey: "painter-mod", ipHash: "ip-mod", subnetKey: "subnet-mod" };

describe("bans", () => {
  it("stops a paint that would otherwise land", { timeout: 30_000 }, async () => {
    const war = await makeWar({ width: 8, height: 8 });
    const token = await makeToken(war.id, 3);

    const before = await paintPixel({ war, x: 0, y: 0, tokenId: token, colourSlot: 5, ...KEYS });
    expect(before.ok).toBe(true);

    await banKey({
      keyType: "painter",
      key: KEYS.painterKey,
      reason: "test",
      actor: "admin",
      expiresAt: new Date(Date.now() + 3_600_000),
    });

    const after = await paintPixel({ war, x: 1, y: 1, tokenId: token, colourSlot: 5, ...KEYS });
    expect(after).toMatchObject({ ok: false, reason: "banned" });

    // A banned caller leaves NO row behind — not a pixel, not a cooldown, not
    // an event. An attempt that records something tells the attacker they
    // exist (see bans.ts).
    const pixel = await queryOne(`SELECT 1 AS hit FROM pixels WHERE war_id = $1 AND idx = 9`, [war.id]);
    expect(pixel).toBeNull();
  });

  it("expires, rather than lasting forever by default", { timeout: 30_000 }, async () => {
    const war = await makeWar({ width: 8, height: 8 });
    await banKey({
      keyType: "ip",
      key: "ip-expired",
      reason: null,
      actor: "admin",
      expiresAt: new Date(Date.now() - 1000),
    });

    const client = await pool().connect();
    try {
      expect(
        await isBanned(client, {
          warId: war.id,
          painterKey: "x",
          ipHash: "ip-expired",
          subnetKey: "y",
        }),
      ).toBe(false);
    } finally {
      client.release();
    }
  });

  it("moves an existing ban rather than failing on the unique index", { timeout: 30_000 }, async () => {
    const first = await banKey({
      keyType: "subnet",
      key: "subnet-repeat",
      reason: "first",
      actor: "admin",
      expiresAt: new Date(Date.now() + 1000),
    });
    const second = await banKey({
      keyType: "subnet",
      key: "subnet-repeat",
      reason: "again",
      actor: "admin2",
      expiresAt: new Date(Date.now() + 7_200_000),
    });

    expect(second.id).toBe(first.id);
    expect(second.reason).toBe("again");
    expect(second.actor).toBe("admin2");
  });

  it("lists expired bans too, so a second offence does not look like a first", { timeout: 30_000 }, async () => {
    await banKey({ keyType: "ip", key: "ip-old", reason: null, actor: "a", expiresAt: new Date(Date.now() - 1000) });
    await banKey({ keyType: "ip", key: "ip-now", reason: null, actor: "a", expiresAt: new Date(Date.now() + 3_600_000) });

    const bans = await listBans();
    const keys = bans.map((b) => b.key);
    expect(keys).toContain("ip-old");
    expect(keys).toContain("ip-now");
    // Live first.
    expect(bans.find((b) => b.key === "ip-now")!.live).toBe(true);
    expect(bans.find((b) => b.key === "ip-old")!.live).toBe(false);
  });

  it("lifts a ban and lets the painter back", { timeout: 30_000 }, async () => {
    const ban = await banKey({
      keyType: "painter",
      key: "painter-lift",
      reason: null,
      actor: "admin",
      expiresAt: null,
    });

    expect(await liftBan(ban.id)).toBe(true);
    expect(await liftBan(ban.id)).toBe(false);
  });
});

describe("pixel inspection", () => {
  it("names the current painter and admits it cannot name the earlier ones", { timeout: 30_000 }, async () => {
    const war = await makeWar({ width: 8, height: 8 });
    const alpha = await makeToken(war.id, 3);
    const beta = await makeToken(war.id, 9);

    await paintRaw(war.id, 10, alpha, 5, 1);
    await paintRaw(war.id, 10, beta, 12, 2);

    const found = await inspectPixel(war.id, 2, 1, 8);

    expect(found.current).toMatchObject({ warTokenId: beta, colourSlot: 12 });
    expect(found.timeline).toHaveLength(2);
    // THE HONEST CAVEAT, as a field. pixel_events never carried painter_key
    // or ip_hash, so an overpainted cell yields a real timeline and exactly
    // one bannable painter. An operator who assumes otherwise bans the wrong
    // person, which is why the screen says so.
    expect(found.earlierPaintersUnavailable).toBe(true);
  });

  it("reports an unpainted cell as empty rather than as missing", { timeout: 30_000 }, async () => {
    const war = await makeWar({ width: 8, height: 8 });
    const found = await inspectPixel(war.id, 4, 4, 8);

    expect(found.current).toBeNull();
    expect(found.timeline).toEqual([]);
    expect(found.earlierPaintersUnavailable).toBe(false);
  });
});

describe("revert", () => {
  it("clears a rectangle and takes the counts down with it", { timeout: 30_000 }, async () => {
    const war = await makeWar({ width: 8, height: 8 });
    const token = await makeToken(war.id, 3);
    // A 2x2 block at (1,1)..(2,2), plus one pixel outside it that must survive.
    await paintRaw(war.id, 9, token, 5, 1);
    await paintRaw(war.id, 10, token, 5, 2);
    await paintRaw(war.id, 17, token, 5, 3);
    await paintRaw(war.id, 18, token, 5, 4);
    await paintRaw(war.id, 63, token, 5, 5);
    await execute(`UPDATE token_pixel_counts SET owned = 5, placed = 5 WHERE war_id = $1`, [war.id]);

    const result = await revertRegion({ warId: war.id, width: 8, height: 8, x0: 1, y0: 1, x1: 2, y1: 2 });

    expect(result).toMatchObject({ ok: true, cleared: 4 });
    const left = await query<{ idx: number }>(`SELECT idx FROM pixels WHERE war_id = $1`, [war.id]);
    expect(left.map((r) => r.idx)).toEqual([63]);

    const counts = await queryOne<{ owned: number; placed: number }>(
      `SELECT owned, placed FROM token_pixel_counts WHERE war_id = $1`,
      [war.id],
    );
    // `owned` follows the board; `placed` is a lifetime tally and does not go
    // back down, any more than it does when somebody paints over you.
    expect(counts).toMatchObject({ owned: 1, placed: 5 });
  });

  it("keeps the sequence gapless and moving forward", { timeout: 30_000 }, async () => {
    // THE PROPERTY CLIENTS DEPEND ON. `wars.last_seq` is documented as
    // monotonic and gapless because a client holds a sequence and asks for
    // everything after it. A revert that reset it, or that left holes, would
    // strand every open tab.
    const war = await makeWar({ width: 8, height: 8 });
    const token = await makeToken(war.id, 3);
    await paintRaw(war.id, 0, token, 5, 1);
    await paintRaw(war.id, 1, token, 5, 2);

    const result = await revertRegion({ warId: war.id, width: 8, height: 8, x0: 0, y0: 0, x1: 1, y1: 0 });
    expect(result.ok).toBe(true);

    const head = await queryOne<{ last_seq: string }>(`SELECT last_seq FROM wars WHERE id = $1`, [war.id]);
    expect(Number(head!.last_seq)).toBe(4);

    const seqs = await query<{ seq: string }>(
      `SELECT seq FROM pixel_events WHERE war_id = $1 ORDER BY seq`,
      [war.id],
    );
    expect(seqs.map((r) => Number(r.seq))).toEqual([1, 2, 3, 4]);

    // Cleared cells are announced as slot 0, which every client already
    // renders as unpainted, with no owner.
    const cleared = await query<{ colour_slot: number; war_token_id: string | null }>(
      `SELECT colour_slot, war_token_id FROM pixel_events WHERE war_id = $1 AND seq > 2`,
      [war.id],
    );
    expect(cleared).toEqual([
      { colour_slot: 0, war_token_id: null },
      { colour_slot: 0, war_token_id: null },
    ]);
  });

  it("refuses a region off the board and one that is too large", { timeout: 30_000 }, async () => {
    const war = await makeWar({ width: 8, height: 8 });

    expect(await revertRegion({ warId: war.id, width: 8, height: 8, x0: 0, y0: 0, x1: 99, y1: 0 }))
      .toMatchObject({ ok: false, reason: "out_of_bounds" });

    const big = Math.ceil(Math.sqrt(MAX_REVERT_CELLS)) + 10;
    expect(
      await revertRegion({ warId: war.id, width: 4000, height: 4000, x0: 0, y0: 0, x1: big, y1: big }),
    ).toMatchObject({ ok: false, reason: "too_large" });
  });

  it("is a no-op on an already empty region", { timeout: 30_000 }, async () => {
    const war = await makeWar({ width: 8, height: 8 });
    const result = await revertRegion({ warId: war.id, width: 8, height: 8, x0: 0, y0: 0, x1: 3, y1: 3 });
    expect(result).toMatchObject({ ok: true, cleared: 0 });
  });
});

describe("the kill switch", () => {
  it("ends a live war and stops the next paint dead", { timeout: 30_000 }, async () => {
    const war = await makeWar({ width: 8, height: 8 });
    const token = await makeToken(war.id, 3);

    expect(await paintPixel({ war, x: 0, y: 0, tokenId: token, colourSlot: 5, ...KEYS })).toMatchObject({ ok: true });

    expect(await endWarNow(war.id)).toBe(true);

    // `paintPixel` reads the war row inside its own transaction, so a war
    // ended a millisecond ago refuses the request already in flight.
    const after = await paintPixel({
      war,
      x: 4,
      y: 4,
      tokenId: token,
      colourSlot: 5,
      painterKey: "other",
      ipHash: "other",
      subnetKey: "other",
    });
    expect(after).toMatchObject({ ok: false, reason: "war_not_live" });
  });

  it("moves the clock with the status, so the screen cannot argue with itself", { timeout: 30_000 }, async () => {
    const war = await makeWar({ width: 8, height: 8 });
    await endWarNow(war.id);

    const ended = await warById(war.id);
    expect(ended!.status).toBe("ended");
    // The rail counts down to ends_at. A war marked ended with an hour still
    // on its face is a screen disagreeing with its own database.
    expect(ended!.endsAt.getTime()).toBeLessThanOrEqual(Date.now() + 1000);
    expect(ended!.endedAt).not.toBeNull();
  });

  it("refuses a war that is not live", { timeout: 30_000 }, async () => {
    const war = await makeWar({ width: 8, height: 8, status: "scheduled" });
    expect(await endWarNow(war.id)).toBe(false);

    const untouched = await warById(war.id);
    expect(untouched!.status).toBe("scheduled");
  });
});

beforeEach(async () => {
  // The suite truncates between tests, so nothing leaks; this is here to make
  // the dependency explicit for a reader.
  await execute(`DELETE FROM bans WHERE id IS NOT NULL`);
});

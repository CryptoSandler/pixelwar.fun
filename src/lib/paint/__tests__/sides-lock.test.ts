import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { makeToken, makeWar, registerPainter } from "../../canvas/__tests__/fixtures";
import { pool, queryOne } from "../../db";
import { paintPixel } from "../paint";

/**
 * The last window closes the sides, and it can never cost a write.
 *
 * WHY THE SCARCITY IS OVER JOINING RATHER THAN OVER PAINTING. A war's ending
 * is the reason anybody is watching, and the obvious way to make it matter is
 * to make the final minutes count for more. Every version of that idea
 * CONCENTRATES PAINT at the exact moment concurrency peaks, and
 * `docs/operations.md` measures what happens then: every paint holds a row
 * lock on `wars` for five round trips, throughput is `1 / (5 x round-trip
 * time)`, and "nothing about connection pools, instance count or CPU changes
 * it". A spike does not degrade there, it queues, and the war stalls for
 * everybody.
 *
 * So the scarce thing is picking a side. In the last window a painter who has
 * never painted in this war can no longer choose one; a painter who already
 * has an allegiance is untouched. The rule can only ever turn a paint into a
 * refusal, so it cannot raise the paint rate under any input — and the
 * refusal lands before the sequence lock, so it does not even queue behind
 * one. The last two tests here are what make that a fact rather than a claim.
 */

const KEYS = { ipHash: "ip-lock", subnetKey: "subnet-lock" };
const PAINTERS = ["veteran", "latecomer", "l2", "l3", "l4", "l5"];

const original = process.env.PAINT_SIDES_LOCK_MINUTES;

beforeEach(async () => {
  delete process.env.PAINT_SIDES_LOCK_MINUTES;
  for (const key of PAINTERS) await registerPainter(key);
});

afterEach(() => {
  if (original === undefined) delete process.env.PAINT_SIDES_LOCK_MINUTES;
  else process.env.PAINT_SIDES_LOCK_MINUTES = original;
});

/**
 * Holds the `wars` row lock on its own connection, and hands back a release.
 *
 * This is the instrument the throughput claim needs. `UPDATE wars SET
 * last_seq = last_seq + 1` is the statement the ~40 paints per second ceiling
 * is made of, and anything that reaches it while somebody else holds the row
 * WAITS. So: take the lock here, and a paint that never touches it answers
 * immediately while a paint that does cannot answer at all.
 *
 * `FOR NO KEY UPDATE` AND NOT `FOR UPDATE`, and the difference is the whole
 * instrument. `FOR NO KEY UPDATE` is the strength Postgres gives an UPDATE
 * that leaves the key columns alone, which is exactly what the sequence
 * update is — so it conflicts with the statement under test and with nothing
 * else. `FOR UPDATE` is stronger: it also blocks the `FOR KEY SHARE` that
 * every foreign key into `wars` takes, and the `war_painters` INSERT above
 * the refusal has one. Written as `FOR UPDATE` first, this reported the
 * correct implementation as blocked — a false positive from an instrument
 * that measured more than the claim.
 */
async function holdWarRowLock(warId: string): Promise<() => Promise<void>> {
  const client = await pool().connect();
  await client.query("BEGIN");
  await client.query(`SELECT id FROM wars WHERE id = $1 FOR NO KEY UPDATE`, [warId]);
  return async () => {
    await client.query("ROLLBACK").catch(() => {});
    client.release();
  };
}

describe("with no lock configured", () => {
  /**
   * THE CONTROL, AND IT IS THE MOST IMPORTANT TEST IN THIS FILE.
   *
   * Every other case here arranges a war one minute from its end and asserts
   * a refusal. If the default were anything but "off", or if the world these
   * tests build could not paint for some unrelated reason, they would all
   * pass for the wrong reason and nobody would know. This one paints in
   * exactly the arrangement the others refuse.
   */
  it("lets a brand-new painter pick a side one minute before the end", { timeout: 30_000 }, async () => {
    const war = await makeWar({ endsAt: new Date(Date.now() + 60_000) });
    const token = await makeToken(war.id, 3);

    const painted = await paintPixel({
      war, x: 0, y: 0, tokenId: token, colourSlot: 7, painterKey: "latecomer", ...KEYS,
    });

    expect(painted).toMatchObject({ ok: true, allegianceTokenId: token });
  });

  it("reads a garbage value as no lock rather than as some lock", { timeout: 30_000 }, async () => {
    // A typo in the environment must not switch on a rule about what winning
    // means. Off is the safe failure; the parse falls back rather than
    // throwing, for the reason `positiveInt` documents.
    process.env.PAINT_SIDES_LOCK_MINUTES = "sixty";
    const war = await makeWar({ endsAt: new Date(Date.now() + 60_000) });
    const token = await makeToken(war.id, 3);

    const painted = await paintPixel({
      war, x: 0, y: 0, tokenId: token, colourSlot: 7, painterKey: "l2", ...KEYS,
    });

    expect(painted).toMatchObject({ ok: true });
  });
});

describe("with the sides locked", () => {
  it("refuses a painter who has not picked a side yet, and says why", { timeout: 30_000 }, async () => {
    process.env.PAINT_SIDES_LOCK_MINUTES = "60";
    const war = await makeWar({ endsAt: new Date(Date.now() + 60_000) });
    const token = await makeToken(war.id, 3);

    const refused = await paintPixel({
      war, x: 0, y: 0, tokenId: token, colourSlot: 7, painterKey: "latecomer", ...KEYS,
    });

    expect(refused).toMatchObject({ ok: false, reason: "sides_locked" });
    if (refused.ok) throw new Error("unreachable");
    // States the fact and its deadline. It does not scold, and it does not
    // say "permanent" — the same discipline `wrong_allegiance` is held to,
    // for the same reason: the copy must not claim more than the rule does.
    expect(refused.message).toBe(
      "Sides closed for the last 60 minutes of this war. This one is fought with the armies it has.",
    );
  });

  it("leaves a painter who already has a side completely alone", { timeout: 30_000 }, async () => {
    // The rule is about JOINING, not about painting. A war whose last hour
    // stopped its own armies painting would be a war that ends in silence,
    // which is the opposite of the point.
    // The shortest cooldown the schema allows, waited out below. This painter
    // has to paint twice inside one test and the painter cooldown is keyed on
    // `painterKey` — at the default 30s the second paint is refused for a
    // reason that has nothing to do with the rule under test, which would
    // make this case pass or fail on the wrong thing.
    const war = await makeWar({ endsAt: new Date(Date.now() + 60_000), cooldownSeconds: 1 });
    const token = await makeToken(war.id, 3);

    const first = await paintPixel({
      war, x: 0, y: 0, tokenId: token, colourSlot: 7, painterKey: "veteran", ...KEYS,
    });
    expect(first).toMatchObject({ ok: true });

    await new Promise((resolve) => setTimeout(resolve, 1_200));
    process.env.PAINT_SIDES_LOCK_MINUTES = "60";

    const second = await paintPixel({
      war, x: 1, y: 1, tokenId: token, colourSlot: 7, painterKey: "veteran",
      ipHash: "ip-lock-2", subnetKey: "subnet-lock-2",
    });

    expect(second).toMatchObject({ ok: true, allegianceTokenId: token });
  });

  it("does not bite before the window opens", { timeout: 30_000 }, async () => {
    process.env.PAINT_SIDES_LOCK_MINUTES = "60";
    // Ends in three hours: outside a sixty-minute window by a wide margin.
    const war = await makeWar({ endsAt: new Date(Date.now() + 3 * 3_600_000) });
    const token = await makeToken(war.id, 3);

    const painted = await paintPixel({
      war, x: 0, y: 0, tokenId: token, colourSlot: 7, painterKey: "l3", ...KEYS,
    });

    expect(painted).toMatchObject({ ok: true });
  });
});

describe("the refusal costs the write path nothing", () => {
  /**
   * THE CLAIM THIS DESIGN WAS CHOSEN FOR, ASSERTED RATHER THAN ARGUED — AND
   * THE FIRST VERSION OF THIS TEST WAS WORTHLESS.
   *
   * It read `wars.last_seq` before and after and asserted it had not moved.
   * That passes no matter where the check sits, because the transaction rolls
   * back either way and a rolled-back increment leaves no trace. The test was
   * measuring rollback, which is guaranteed, and reporting it as evidence
   * about the row lock, which is not. It was FALSIFIED by moving the refusal
   * below the sequence update: it stayed green.
   *
   * A rolled-back transaction that took the lock still blocked everybody else
   * while it held it, so state after the fact cannot answer this question at
   * all. The question is about a duration, so the check has to span one: hold
   * the `wars` row on another connection, then refuse a latecomer. A refusal
   * that never reaches `UPDATE wars SET last_seq` answers immediately; one
   * that does reach it waits for the lock and blows the timeout.
   *
   * Falsify it the same way — move the throw below the sequence update — and
   * this one hangs instead of passing.
   */
  it("answers without ever waiting on the row lock the ceiling is made of", { timeout: 30_000 }, async () => {
    process.env.PAINT_SIDES_LOCK_MINUTES = "60";
    const war = await makeWar({ endsAt: new Date(Date.now() + 60_000) });
    const token = await makeToken(war.id, 3);

    const release = await holdWarRowLock(war.id);
    try {
      const refused = await Promise.race([
        paintPixel({ war, x: 0, y: 0, tokenId: token, colourSlot: 7, painterKey: "l4", ...KEYS }),
        new Promise((resolve) => setTimeout(() => resolve("blocked on the row lock"), 5_000)),
      ]);
      expect(refused).toMatchObject({ ok: false, reason: "sides_locked" });
    } finally {
      await release();
    }
  });

  it("leaves no allegiance, no pixel and no cooldown behind", { timeout: 30_000 }, async () => {
    process.env.PAINT_SIDES_LOCK_MINUTES = "60";
    const war = await makeWar({ endsAt: new Date(Date.now() + 60_000) });
    const token = await makeToken(war.id, 3);

    await paintPixel({
      war, x: 2, y: 2, tokenId: token, colourSlot: 7, painterKey: "l5", ...KEYS,
    });

    // The allegiance row is INSERTed before the refusal can know it was a new
    // painter — the INSERT is how it knows. So the whole transaction has to
    // roll back, exactly as a refused cooldown does, or the lock would commit
    // the very allegiance it just refused.
    const sworn = await queryOne(
      `SELECT 1 FROM war_painters WHERE war_id = $1 AND painter_key = $2`,
      [war.id, "l5"],
    );
    expect(sworn).toBeNull();

    const pixel = await queryOne(
      `SELECT 1 FROM pixels WHERE war_id = $1 AND idx = $2`,
      [war.id, 2 * war.width + 2],
    );
    expect(pixel).toBeNull();

    const cooldown = await queryOne(
      `SELECT 1 FROM paint_cooldowns WHERE war_id = $1 AND key = $2`,
      [war.id, "l5"],
    );
    expect(cooldown).toBeNull();
  });
});

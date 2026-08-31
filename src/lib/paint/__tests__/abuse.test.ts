import { describe, expect, it } from "vitest";
import { makeToken, makeWar, paintRaw } from "../../canvas/__tests__/fixtures";
import { execute } from "../../db";
import {
  ABUSE_CELL_PAINTS,
  ABUSE_WINDOW_MINUTES,
  abuseSignal,
  currentAbuseSignal,
} from "../abuse";

/**
 * "Something odd is happening", and nothing more.
 *
 * These tests pin the two things the signal must get right — rate and
 * concentration — and one thing it must NOT do, which is treat a moderator's
 * cleanup as suspicious activity.
 *
 * They deliberately do not test "detects abuse". It cannot: a raid and an
 * attack are the same shape, which is why nothing acts on this and a human
 * decides. See `abuse.ts`.
 */

async function paintCluster(warId: string, token: string, from: number, count: number, width = 200) {
  for (let i = 0; i < count; i++) {
    // Inside one 10x10 cell: x stays in [from, from+9], y walks down.
    const x = from + (i % 10);
    const y = Math.floor(i / 10);
    await paintRaw(warId, y * width + x, token, 5, i + 1);
  }
}

describe("the board signal", () => {
  it("is quiet on a board nobody is painting", { timeout: 40_000 }, async () => {
    const war = await makeWar({ width: 200, height: 200 });
    const signal = await abuseSignal(war.id, 200);

    expect(signal).toMatchObject({ paints: 0, perMinute: 0, hottest: null, worthALook: false });
  });

  it("names the busiest cell by its top-left corner", { timeout: 60_000 }, async () => {
    const war = await makeWar({ width: 200, height: 200 });
    const token = await makeToken(war.id, 3);
    // 30 paints inside the cell whose corner is (40, 0).
    await paintCluster(war.id, token, 40, 30);

    const signal = await abuseSignal(war.id, 200);
    expect(signal.paints).toBe(30);
    expect(signal.hottest).toMatchObject({ x: 40, y: 0 });
  });

  it("says look when one cell fills up, even at a modest overall rate", { timeout: 60_000 }, async () => {
    // CONCENTRATION MATTERS MORE THAN VOLUME. A busy war is paints
    // everywhere; a picture is paints in one place, and the picture is the
    // thing an operator has to look at.
    const war = await makeWar({ width: 200, height: 200 });
    const token = await makeToken(war.id, 3);
    await paintCluster(war.id, token, 100, ABUSE_CELL_PAINTS + 5);

    const signal = await abuseSignal(war.id, 200);
    expect(signal.hottest!.paints).toBeGreaterThanOrEqual(ABUSE_CELL_PAINTS);
    expect(signal.worthALook).toBe(true);
    // And it is not the overall rate that tripped it.
    expect(signal.perMinute).toBeLessThan(120);
  });

  it("ignores paints older than the window", { timeout: 60_000 }, async () => {
    const war = await makeWar({ width: 200, height: 200 });
    const token = await makeToken(war.id, 3);
    await paintCluster(war.id, token, 10, 20);
    await execute(
      `UPDATE pixel_events SET painted_at = now() - ($2 || ' minutes')::interval WHERE war_id = $1`,
      [war.id, String(ABUSE_WINDOW_MINUTES + 5)],
    );

    const signal = await abuseSignal(war.id, 200);
    expect(signal.paints).toBe(0);
    expect(signal.worthALook).toBe(false);
  });

  it("does not count a moderator's cleanup as activity", { timeout: 60_000 }, async () => {
    // `revertRegion` writes events with colour 0 and NO token. Counting those
    // would make the alert fire hardest immediately after somebody dealt with
    // the thing it was warning about.
    const war = await makeWar({ width: 200, height: 200 });
    await execute(
      `INSERT INTO pixel_events (war_id, seq, idx, colour_slot, war_token_id, painted_at)
       SELECT $1, g, g, 0, NULL, now() FROM generate_series(1, 80) AS g`,
      [war.id],
    );

    const signal = await abuseSignal(war.id, 200);
    expect(signal.paints).toBe(0);
    expect(signal.worthALook).toBe(false);
  });

  it("reports nothing when no war is live", { timeout: 40_000 }, async () => {
    await makeWar({ status: "ended" });
    expect(await currentAbuseSignal()).toBeNull();
  });
});

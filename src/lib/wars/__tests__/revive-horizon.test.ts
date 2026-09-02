import { describe, expect, it } from "vitest";
import { makeToken, makeWar, paintRaw } from "../../canvas/__tests__/fixtures";
import { prunePixelEvents } from "../../canvas/diff";
import { execute, query } from "../../db";
import { REVIVE_HORIZON_DAYS, reviveWar } from "../lifecycle";

/**
 * The horizon and the prune are one decision, and this is where that is held.
 *
 * `pixel_events` is the only table in this schema that can fill the database
 * on its own, and it had no retention. It could not be given one, because
 * `reviveWar` accepted any ended war forever: delete the log of a war
 * somebody might revive and `changesSince` serves a history with holes, so a
 * client polling `?since=` silently misses pixels. Creating the horizon is
 * what made the prune safe — which means the two must never drift apart, and
 * a test of either one alone would not notice if they did.
 */

const DAY = 24 * 60 * 60 * 1000;

/**
 * Puts a war into the past as an ENDED war, the way the clock would have, and
 * gives it a token so pixels can be attributed.
 *
 * `ended_at` is set explicitly rather than left to `advanceWar`, because the
 * horizon is measured from when the war STOPPED and no clock in a test runs
 * for thirty days.
 */
async function endedDaysAgo(days: number): Promise<{ warId: string; tokenId: string }> {
  // `startsAt` moves back with it: the schema has CHECK (ends_at > starts_at)
  // and the default start is an hour ago, so a deadline weeks in the past
  // fails the constraint rather than the test.
  const war = await makeWar({
    startsAt: new Date(Date.now() - (days + 3) * DAY),
    endsAt: new Date(Date.now() - days * DAY),
  });
  await execute(
    `UPDATE wars SET status = 'ended', ended_at = now() - ($2 || ' days')::interval WHERE id = $1`,
    [war.id, String(days)],
  );
  return { warId: war.id, tokenId: await makeToken(war.id, 3) };
}

async function eventCount(warId: string): Promise<number> {
  const rows = await query<{ n: string }>(
    `SELECT count(*) AS n FROM pixel_events WHERE war_id = $1`,
    [warId],
  );
  return Number(rows[0].n);
}

describe(`a war stays revivable for ${REVIVE_HORIZON_DAYS} days`, () => {
  it("revives at 29 days and keeps every event", { timeout: 30_000 }, async () => {
    const { warId, tokenId } = await endedDaysAgo(29);
    await paintRaw(warId, 0, tokenId, 3, 1);
    await paintRaw(warId, 1, tokenId, 3, 2);
    expect(await eventCount(warId)).toBe(2);

    const revived = await reviveWar(warId, new Date(Date.now() + DAY));
    expect(revived).toMatchObject({ ok: true });

    // The sweep runs against the whole table, not against this war, because
    // that is how it runs in production — and a revived war must survive it.
    // `reviveWar` clears `ended_at`, so the candidate query no longer sees it.
    await prunePixelEvents();
    expect(await eventCount(warId)).toBe(2);
  });

  it("refuses at 31 days, by name", { timeout: 30_000 }, async () => {
    const { warId } = await endedDaysAgo(31);

    const refused = await reviveWar(warId, new Date(Date.now() + DAY));
    expect(refused).toMatchObject({ ok: false, reason: "too_old_to_revive" });
  });

  it("prunes the events of the war it just refused to revive", { timeout: 30_000 }, async () => {
    const { warId, tokenId } = await endedDaysAgo(31);
    await paintRaw(warId, 0, tokenId, 3, 1);
    await paintRaw(warId, 1, tokenId, 3, 2);
    expect(await eventCount(warId)).toBe(2);

    expect(await prunePixelEvents()).toBeGreaterThanOrEqual(2);
    expect(await eventCount(warId)).toBe(0);
  });

  /**
   * THE PROPERTY THAT MATTERS AND THAT NEITHER TEST ABOVE CAN SEE ALONE:
   * nothing is ever pruned while it is still revivable.
   *
   * Falsify it by changing either the constant in `lifecycle.ts` or the `30`
   * the prune would have hard-coded if it had one — the point of this case is
   * that there is no second number to change.
   */
  it("never prunes a war that can still be revived", { timeout: 30_000 }, async () => {
    const { warId: stillRevivable, tokenId } = await endedDaysAgo(REVIVE_HORIZON_DAYS - 1);
    await paintRaw(stillRevivable, 5, tokenId, 3, 1);

    await prunePixelEvents();

    expect(await eventCount(stillRevivable)).toBe(1);
    expect(await reviveWar(stillRevivable, new Date(Date.now() + DAY))).toMatchObject({ ok: true });
  });

  it("leaves the board and the standings behind when it prunes", { timeout: 30_000 }, async () => {
    const { warId, tokenId } = await endedDaysAgo(45);
    await paintRaw(warId, 7, tokenId, 3, 1);

    await prunePixelEvents();

    // The result screen reads these two. Losing the log must not lose the
    // board or the winner — that is the whole reason the prune is scoped to
    // `pixel_events` and nothing else.
    const pixels = await query<{ n: string }>(
      `SELECT count(*) AS n FROM pixels WHERE war_id = $1`,
      [warId],
    );
    expect(Number(pixels[0].n)).toBe(1);

    const counts = await query<{ n: string }>(
      `SELECT count(*) AS n FROM token_pixel_counts WHERE war_id = $1`,
      [warId],
    );
    expect(Number(counts[0].n)).toBeGreaterThan(0);
  });
});

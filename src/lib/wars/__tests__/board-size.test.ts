import { describe, expect, it } from "vitest";
import { canvasBytes } from "../../canvas/state";
import { changesSince } from "../../canvas/diff";
import { makeToken, registerPainter } from "../../canvas/__tests__/fixtures";
import { query } from "../../db";
import { paintPixel } from "../../paint/paint";
import { warById } from "../lifecycle";
import { createWar, MAX_BOARD_SIDE, MIN_BOARD_SIDE } from "../operate";

/**
 * A war that is not 200 a side, running end to end.
 *
 * WHAT THIS IS NOT TESTING, because it was already true. `wars.width` and
 * `wars.height` have existed since migration 001 and every reader already
 * takes its size from them — `canvasBytes` allocates `war.width *
 * war.height`, `BoardImage` allocates from the pair, the scoreboard divides by
 * it. Per-war size was never a constant here, and a test asserting that a 400
 * board *can exist* would have passed before this batch.
 *
 * WHAT WAS MISSING: nothing bounded either column, and nothing let an operator
 * set them. A war of 100000 a side was accepted by the schema, and the first
 * request for its board asks for a ten-gigabyte allocation. So the cases that
 * matter are the ends of the range and the fact that the size reaches the two
 * read paths a spectator actually hits.
 */

const KEYS = { ipHash: "ip-size", subnetKey: "subnet-size" };

async function scheduleWar(slug: string, width: number, height: number) {
  return createWar({
    slug,
    title: `Board ${width}x${height}`,
    entryPriceLamports: 25_000_000n,
    cooldownSeconds: 1,
    startsAt: new Date(Date.now() - 3_600_000),
    endsAt: new Date(Date.now() + 3_600_000),
    width,
    height,
  });
}

describe("a war carries its own board size", () => {
  it("runs a 400x400 war through create, paint, canvas and diff", { timeout: 60_000 }, async () => {
    const slug = `four-hundred-${Date.now().toString(36)}`;
    const created = await scheduleWar(slug, 400, 400);
    expect(created).toMatchObject({ ok: true });
    if (!created.ok) throw new Error("unreachable");

    const war = created.value;
    expect(war).toMatchObject({ width: 400, height: 400 });

    // `createWar` opens a war SCHEDULED, never live — `advanceWar` is what
    // turns it live, and its start is already in the past, so it flips on the
    // first read. Painting needs it live.
    const live = (await warById(war.id))!;
    await query(`UPDATE wars SET status = 'live' WHERE id = $1`, [war.id]);
    const token = await makeToken(war.id, 3);
    await registerPainter("painter-400");

    // A pixel only this board has: index 399,399 is off the end of a 200 board.
    const far = { x: 399, y: 399 };
    const painted = await paintPixel({
      war: { ...live, status: "live" },
      x: far.x, y: far.y, tokenId: token, colourSlot: 7,
      painterKey: "painter-400", ...KEYS,
    });
    expect(painted).toMatchObject({ ok: true });

    // THE CANVAS IS ONE BYTE PER PIXEL and must be the war's own area, not
    // 40,000. This is the assertion the whole batch is about.
    const fresh = (await warById(war.id))!;
    const { bytes } = await canvasBytes(fresh, "colour");
    expect(bytes.length).toBe(400 * 400);
    expect(bytes.length).not.toBe(200 * 200);

    // And the painted pixel is at the index this board's width implies.
    expect(bytes[far.y * 400 + far.x]).toBe(7);

    // The diff protocol reads the same war and reaches the same pixel.
    const diff = await changesSince(fresh, 0, 8000, "colour");
    expect(diff.resync).toBe(false);
    if (diff.resync) throw new Error("unreachable");
    expect(diff.changes).toContainEqual([far.y * 400 + far.x, 7]);
  });

  it("refuses a board below the floor and above the ceiling, by name", { timeout: 30_000 }, async () => {
    const tooSmall = await scheduleWar(`tiny-${Date.now().toString(36)}`, MIN_BOARD_SIDE - 1, 200);
    expect(tooSmall).toMatchObject({ ok: false, reason: "bad_numbers" });

    const tooBig = await scheduleWar(`huge-${Date.now().toString(36)}`, 200, MAX_BOARD_SIDE + 1);
    expect(tooBig).toMatchObject({ ok: false, reason: "bad_numbers" });

    // The ends themselves are allowed — without this the two above would pass
    // against a function that rejects every size.
    const floor = await scheduleWar(`floor-${Date.now().toString(36)}`, MIN_BOARD_SIDE, MIN_BOARD_SIDE);
    expect(floor).toMatchObject({ ok: true });
    const ceiling = await scheduleWar(`ceil-${Date.now().toString(36)}`, MAX_BOARD_SIDE, MAX_BOARD_SIDE);
    expect(ceiling).toMatchObject({ ok: true });
  });

  it("defaults to 200 when no size is asked for", { timeout: 30_000 }, async () => {
    const created = await scheduleWar(`default-${Date.now().toString(36)}`, undefined as never, undefined as never);
    expect(created).toMatchObject({ ok: true });
    if (!created.ok) throw new Error("unreachable");
    expect(created.value).toMatchObject({ width: 200, height: 200 });
  });

  /**
   * The database refuses too, and that is not redundant with the check above.
   * `createWar` is one writer; the constraint is what makes the bound true of
   * a seed script, a psql session, or a route nobody has written yet.
   */
  it("is refused by the schema, not only by the application", { timeout: 30_000 }, async () => {
    await expect(
      query(
        `INSERT INTO wars (id, slug, title, status, width, height, entry_price_usd,
                           entry_price_sol, cooldown_seconds, starts_at, ends_at)
         VALUES (gen_random_uuid(), $1, 'Too big', 'draft', 100000, 100000, 1, 25000000, 30,
                 now(), now() + interval '1 day')`,
        [`raw-${Date.now().toString(36)}`],
      ),
    ).rejects.toThrow(/wars_board_size_bounds/);
  });
});

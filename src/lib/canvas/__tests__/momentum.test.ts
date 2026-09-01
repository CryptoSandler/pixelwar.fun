import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { execute } from "../../db";
import { makeToken, makeWar } from "./fixtures";
import { MOMENTUM_MINUTES, territoryMomentum } from "../momentum";

/**
 * The signal that tells a community it is being taken apart right now.
 *
 * Every test here writes events by hand rather than painting, because what is
 * under test is the arithmetic over history — including histories a paint
 * path would take an hour to produce.
 */

let seq = 0;
async function event(warId: string, idx: number, token: string | null, minutesAgo: number) {
  seq += 1;
  await execute(
    `INSERT INTO pixel_events (war_id, seq, idx, colour_slot, war_token_id, painted_at)
     VALUES ($1, $2, $3, 7, $4, now() - ($5 || ' minutes')::interval)`,
    [warId, seq, idx, token, String(minutesAgo)],
  );
}

describe("which way the board is moving", () => {
  it("counts a pixel taken as a gain for one side and a loss for the other", { timeout: 20_000 }, async () => {
    const war = await makeWar();
    const red = await makeToken(war.id, 1);
    const blue = await makeToken(war.id, 2);

    await event(war.id, 10, red, 5);
    await event(war.id, 10, blue, 4); // blue takes it from red

    const momentum = await territoryMomentum(war.id);
    expect(momentum.get(blue)).toMatchObject({ gained: 1, lost: 0, net: 1 });
    expect(momentum.get(red)).toMatchObject({ gained: 1, lost: 1, net: 0 });
  });

  it("counts repainting your own pixel as neither a gain nor a loss", { timeout: 20_000 }, async () => {
    // A community tidying its own art is neither losing ground nor taking it.
    // The loss is the obvious half; the GAIN is the half that was wrong, and
    // it is the one that matters — counting every event as a gain would make
    // retouching your own work the fastest-rising number on the board, so the
    // signal would climb hardest for whoever is under the least pressure.
    //
    // Two events, one cell: the first takes a cell red was not holding, which
    // is a real gain. The second changes nothing about who holds it.
    const war = await makeWar();
    const red = await makeToken(war.id, 1);

    await event(war.id, 3, red, 5);
    await event(war.id, 3, red, 4);

    expect(momentumOf(await territoryMomentum(war.id), red)).toMatchObject({
      gained: 1,
      lost: 0,
      net: 1,
    });
  });

  it("ignores anything older than the window", { timeout: 20_000 }, async () => {
    const war = await makeWar();
    const red = await makeToken(war.id, 1);
    const blue = await makeToken(war.id, 2);

    await event(war.id, 4, red, MOMENTUM_MINUTES + 5);
    await event(war.id, 4, blue, MOMENTUM_MINUTES + 4);

    expect(await territoryMomentum(war.id)).toEqual(new Map());
  });

  it("ignores moderation cleanup, like the activity feed does", { timeout: 20_000 }, async () => {
    // A revert writes events with no token. Somebody having their vandalism
    // removed is not a community losing a fight, and counting it would put a
    // moderator's action on a scoreboard.
    const war = await makeWar();
    const red = await makeToken(war.id, 1);

    await event(war.id, 8, red, 5);
    await event(war.id, 8, null, 4);

    const momentum = await territoryMomentum(war.id);
    expect(momentum.get(red)).toMatchObject({ lost: 0 });
  });

  it("reports nothing at all for a war nobody has painted", { timeout: 20_000 }, async () => {
    const war = await makeWar();
    await makeToken(war.id, 1);
    expect(await territoryMomentum(war.id)).toEqual(new Map());
  });

  it("adds up across many cells", { timeout: 20_000 }, async () => {
    const war = await makeWar();
    const red = await makeToken(war.id, 1);
    const blue = await makeToken(war.id, 2);

    for (let idx = 100; idx < 110; idx++) {
      await event(war.id, idx, red, 6);
      await event(war.id, idx, blue, 3);
    }

    expect(momentumOf(await territoryMomentum(war.id), red)).toMatchObject({ lost: 10, net: 0 });
    expect(momentumOf(await territoryMomentum(war.id), blue)).toMatchObject({ gained: 10, net: 10 });
  });
});

function momentumOf(map: Awaited<ReturnType<typeof territoryMomentum>>, token: string) {
  const entry = map.get(token);
  if (!entry) throw new Error(`no momentum recorded for ${token}`);
  return entry;
}

// Kept so the unused-import lint does not fire on a helper the file uses only
// through `momentumOf`.
void randomUUID;

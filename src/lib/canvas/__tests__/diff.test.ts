import { describe, expect, it } from "vitest";
import { changesSince } from "../diff";
import { makeToken, makeWar, paintRaw } from "./fixtures";

describe("changesSince", () => {
  it("returns nothing when the client is up to date", async () => {
    const war = await makeWar();
    const red = await makeToken(war.id, 1);
    await paintRaw(war.id, 1, red, 1, 1);

    const result = await changesSince(war, 1);
    expect(result).toEqual({ resync: false, seq: 1, changes: [] });
  });

  it("returns only what happened after the given sequence, in order", async () => {
    const war = await makeWar();
    const red = await makeToken(war.id, 1);
    const blue = await makeToken(war.id, 13);

    await paintRaw(war.id, 1, red, 1, 1);
    await paintRaw(war.id, 2, blue, 13, 2);
    await paintRaw(war.id, 3, red, 1, 3);

    const result = await changesSince(war, 1);
    expect(result).toEqual({
      resync: false,
      seq: 3,
      changes: [
        [2, 13],
        [3, 1],
      ],
    });
  });

  it("asks the client to refetch rather than shipping a quarter of the board", async () => {
    const war = await makeWar();
    const red = await makeToken(war.id, 1);
    for (let seq = 1; seq <= 12; seq++) await paintRaw(war.id, seq, red, 1, seq);

    const result = await changesSince(war, 0, 10);
    expect(result).toEqual({ resync: true, seq: 12 });
  });

  it("is safe against a client that reports a sequence from the future", async () => {
    const war = await makeWar();
    const red = await makeToken(war.id, 1);
    await paintRaw(war.id, 1, red, 1, 1);

    const result = await changesSince(war, 999);
    expect(result).toEqual({ resync: false, seq: 1, changes: [] });
  });

  it("carries the colour of a cleared pixel as slot 0", async () => {
    const war = await makeWar();
    const red = await makeToken(war.id, 1);
    await paintRaw(war.id, 4, red, 1, 1);
    // An admin clearing a rectangle emits slot 0 events, so clients converge
    // through the ordinary diff rather than being told to resync.
    await paintRaw(war.id, 4, red, 0, 2);

    const result = await changesSince(war, 1);
    expect(result).toMatchObject({ changes: [[4, 0]] });
  });
});

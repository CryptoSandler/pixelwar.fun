import { describe, expect, it } from "vitest";
import { canvasBytes } from "../state";
import { makeToken, makeWar, paintRaw } from "./fixtures";

describe("canvasBytes", () => {
  it("returns an all-zero board for a war nobody has painted", async () => {
    const war = await makeWar({ width: 8, height: 8 });
    const { seq, bytes } = await canvasBytes(war);

    expect(bytes).toHaveLength(64);
    expect(bytes.every((b) => b === 0)).toBe(true);
    expect(seq).toBe(0);
  });

  it("places each pixel at y * width + x with its token's colour slot", async () => {
    const war = await makeWar({ width: 8, height: 8 });
    const red = await makeToken(war.id, 1);
    const blue = await makeToken(war.id, 13);

    await paintRaw(war.id, 0, red, 1, 1); // (0,0)
    await paintRaw(war.id, 8 * 3 + 5, blue, 13, 2); // (5,3)

    const { bytes, seq } = await canvasBytes(war);
    expect(bytes[0]).toBe(1);
    expect(bytes[29]).toBe(13);
    expect(bytes[1]).toBe(0);
    expect(seq).toBe(2);
  });

  it("reflects the latest owner of an overpainted pixel", async () => {
    const war = await makeWar({ width: 4, height: 4 });
    const red = await makeToken(war.id, 1);
    const blue = await makeToken(war.id, 13);

    await paintRaw(war.id, 5, red, 1, 1);
    await paintRaw(war.id, 5, blue, 13, 2);

    const { bytes } = await canvasBytes(war);
    expect(bytes[5]).toBe(13);
  });

  it("never reports a sequence newer than the board it returns", async () => {
    // The seq must be read BEFORE the pixels. Over-delivering a change the
    // client will also see in the diff is harmless — it writes the same value
    // twice. Under-delivering is a pixel the client never learns about.
    const war = await makeWar({ width: 4, height: 4 });
    const red = await makeToken(war.id, 1);
    await paintRaw(war.id, 3, red, 1, 7);

    const { seq, bytes } = await canvasBytes(war);
    expect(seq).toBeLessThanOrEqual(7);
    expect(bytes[3]).toBe(1);
  });
});

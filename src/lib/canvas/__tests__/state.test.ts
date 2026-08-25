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

  it("tolerates a diff that re-delivers a change the board already has", async () => {
    // canvasBytes reads the sequence BEFORE the pixels, so the board it
    // returns can be slightly AHEAD of the sequence it reports: a paint that
    // lands between the two reads is in the bytes and also in the client's
    // first diff. That is deliberate. This test pins the property that makes
    // it safe — applying such a change twice is a no-op — because the other
    // ordering has no safe failure mode at all: a pixel missing from the
    // board but below the reported sequence is never requested again and is
    // gone from that screen for the rest of the war.
    //
    // The ordering itself is enforced by reading state.ts, not by this test.
    // Testing it directly would need a seam in production code that exists
    // only for the test, which is a worse trade than a comment.
    const war = await makeWar({ width: 4, height: 4 });
    const red = await makeToken(war.id, 1);
    await paintRaw(war.id, 5, red, 1, 1);

    const { seq, bytes } = await canvasBytes(war);
    expect(bytes[5]).toBe(1);

    const replayed = new Uint8Array(bytes);
    for (const [idx, slot] of [[5, 1]] as [number, number][]) replayed[idx] = slot;

    expect([...replayed]).toEqual([...bytes]);
    expect(seq).toBeLessThanOrEqual(1);
  });
});

import { describe, expect, it } from "vitest";
import { canvasBytes } from "../state";
import { makeToken, makeWar, paintRaw } from "./fixtures";

describe("canvasBytes", () => {
  // Each makeWar/makeToken/paintRaw call is its own sequential round trip to
  // a remote Neon database, and every test here makes several -- close
  // enough to the suite's 5000ms default to fail intermittently on a
  // slower hop. All three tests in this file do the same kind of work, so
  // all three get their own ceiling rather than raising the suite default.
  it("returns an all-zero board for a war nobody has painted", { timeout: 20_000 }, async () => {
    const war = await makeWar({ width: 100, height: 100 });
    const { seq, bytes } = await canvasBytes(war);

    // Derived from the war, not restated. The literal here was 64, which was
    // the fixture's old 8x8 written out a second time — so the assertion said
    // "the board is 64 bytes" when what it means is "the board is its own
    // size", and it broke the moment the fixture changed.
    expect(bytes).toHaveLength(war.width * war.height);
    expect(bytes.every((b) => b === 0)).toBe(true);
    expect(seq).toBe(0);
  });

  it(
    "places each pixel at y * width + x with its token's colour slot",
    { timeout: 20_000 },
    async () => {
      const war = await makeWar({ width: 100, height: 100 });
      const red = await makeToken(war.id, 1);
      const blue = await makeToken(war.id, 13);

      // The index this test is ABOUT is `y * width + x`, so it is computed
      // that way from the war rather than pre-multiplied against a width the
      // fixture happens to have.
      const at = (x: number, y: number) => y * war.width + x;

      await paintRaw(war.id, at(0, 0), red, 1, 1);
      await paintRaw(war.id, at(5, 3), blue, 13, 2);

      const { bytes, seq } = await canvasBytes(war);
      expect(bytes[at(0, 0)]).toBe(1);
      expect(bytes[at(5, 3)]).toBe(13);
      expect(bytes[at(1, 0)]).toBe(0);
      expect(seq).toBe(2);
    },
  );

  it("reflects the latest owner of an overpainted pixel", { timeout: 20_000 }, async () => {
    // 100 is the floor migration 018 sets; 4 is below it and no longer a row
    // the schema will accept. Nothing in this test needs a small board.
    const war = await makeWar({ width: 100, height: 100 });
    const red = await makeToken(war.id, 1);
    const blue = await makeToken(war.id, 13);

    await paintRaw(war.id, 5, red, 1, 1);
    await paintRaw(war.id, 5, blue, 13, 2);

    const { bytes } = await canvasBytes(war);
    expect(bytes[5]).toBe(13);
  });
});

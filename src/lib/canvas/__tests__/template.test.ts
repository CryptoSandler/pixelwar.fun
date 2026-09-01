import { describe, expect, it } from "vitest";
import { TEMPLATE_MAX_SIDE, clampTemplate, templateTooLarge } from "../template";

const BOARD = { width: 200, height: 200 };

describe("keeping a template where it can be seen", () => {
  it("leaves a placement that is already fine alone", () => {
    expect(clampTemplate({ x: 50, y: 60 }, { width: 32, height: 32 }, BOARD)).toEqual({
      x: 50,
      y: 60,
    });
  });

  it("pulls a template back onto the board rather than half off the edge", () => {
    expect(clampTemplate({ x: 500, y: -40 }, { width: 32, height: 32 }, BOARD)).toEqual({
      x: 168,
      y: 0,
    });
  });

  it("allows the corner to sit exactly on the far edge", () => {
    // 200 - 32 = 168 is the last placement that keeps all 32 columns on.
    expect(clampTemplate({ x: 168, y: 168 }, { width: 32, height: 32 }, BOARD)).toEqual({
      x: 168,
      y: 168,
    });
  });

  it("rounds a fractional placement to a cell", () => {
    // The overlay is read cell by cell; a corner at x=10.4 has no cell.
    expect(clampTemplate({ x: 10.4, y: 10.6 }, { width: 8, height: 8 }, BOARD)).toEqual({
      x: 10,
      y: 11,
    });
  });

  it("lets a template exactly the size of the board sit only at the origin", () => {
    expect(clampTemplate({ x: 40, y: -40 }, { width: 200, height: 200 }, BOARD)).toEqual({
      x: 0,
      y: 0,
    });
  });

  it("pans an oversized template UNDER the board instead of pinning it", () => {
    // THE CASE A NAIVE CLAMP GETS WRONG. With a 300-wide template on a
    // 200-wide board, `0 .. board - template` is `0 .. -100`, an empty range
    // that collapses to a single point and makes the template unmovable. The
    // corner must be free to go negative so the whole picture can be brought
    // under the board a piece at a time.
    const template = { width: 300, height: 300 };
    expect(clampTemplate({ x: -50, y: -50 }, template, BOARD)).toEqual({ x: -50, y: -50 });
    expect(clampTemplate({ x: -100, y: -100 }, template, BOARD)).toEqual({ x: -100, y: -100 });
    // And no further: past this the board is no longer fully covered.
    expect(clampTemplate({ x: -400, y: -400 }, template, BOARD)).toEqual({ x: -100, y: -100 });
    expect(clampTemplate({ x: 80, y: 80 }, template, BOARD)).toEqual({ x: 0, y: 0 });
  });

  it("handles a template that is oversized on one axis only", () => {
    const template = { width: 300, height: 20 };
    expect(clampTemplate({ x: -50, y: 300 }, template, BOARD)).toEqual({ x: -50, y: 180 });
  });
});

describe("what may be a template at all", () => {
  it("accepts an ordinary community sigil", () => {
    // THE CONTROL. A size check that refuses everything would look exactly
    // like "the file picker is broken".
    expect(templateTooLarge({ width: 64, height: 64 })).toBe(false);
    expect(templateTooLarge({ width: TEMPLATE_MAX_SIDE, height: TEMPLATE_MAX_SIDE })).toBe(false);
  });

  it("refuses a photo, on either axis", () => {
    // Dropped on a 200-wide board a 4,000-pixel photo is nonsense, and drawn
    // every frame it is a stutter.
    expect(templateTooLarge({ width: 4000, height: 3000 })).toBe(true);
    expect(templateTooLarge({ width: 8, height: TEMPLATE_MAX_SIDE + 1 })).toBe(true);
  });
});

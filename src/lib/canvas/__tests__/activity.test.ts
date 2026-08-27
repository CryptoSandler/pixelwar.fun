import { describe, expect, it } from "vitest";
import { activityBounds, openingViewport } from "../activity";

/**
 * Where a war opens.
 *
 * The failure this replaces is not a crash, it is a first impression: a
 * 200x200 board at 3x centred on the coordinate middle shows a visitor forty
 * thousand grey cells and answers "what is happening here" with "nothing",
 * during exactly the hours when a handful of pixels IS what is happening.
 */

function board(width: number, height: number, painted: Array<[number, number]>): Uint8Array {
  const slots = new Uint8Array(width * height);
  for (const [x, y] of painted) slots[y * width + x] = 7;
  return slots;
}

describe("activityBounds", () => {
  it("is null for a board nobody has painted", () => {
    expect(activityBounds(board(8, 8, []), 8, 8)).toBeNull();
  });

  it("boxes a single pixel as one cell, not as nothing", () => {
    // Inclusive bounds: a box from 3 to 3 is one pixel wide. A caller that
    // treated it as zero would divide by it.
    expect(activityBounds(board(8, 8, [[3, 5]]), 8, 8)).toEqual({
      minX: 3,
      minY: 5,
      maxX: 3,
      maxY: 5,
    });
  });

  it("spans every painted pixel and ignores the empty ones between them", () => {
    expect(
      activityBounds(board(10, 10, [[1, 1], [8, 2], [4, 9]]), 10, 10),
    ).toEqual({ minX: 1, minY: 1, maxX: 8, maxY: 9 });
  });
});

describe("openingViewport", () => {
  const screen = { width: 800, height: 600 };
  const size = { width: 200, height: 200 };

  it("centres an empty board close enough for the grid to show", () => {
    const view = openingViewport({ bounds: null, board: size, screen });

    expect(view.centreX).toBe(100);
    expect(view.centreY).toBe(100);
    // Above the grid threshold on purpose: on an empty board the grid is the
    // only thing that says "a surface you can paint on" rather than "this
    // failed to load".
    expect(view.scale).toBeGreaterThanOrEqual(8);
  });

  it("centres on the activity rather than on the board", () => {
    const view = openingViewport({
      bounds: { minX: 10, minY: 20, maxX: 30, maxY: 40 },
      board: size,
      screen,
    });

    // The middle of the activity, not the middle of the plane, and offset
    // half a cell so the centre is inside the pixel rather than on its corner.
    expect(view.centreX).toBe(20.5);
    expect(view.centreY).toBe(30.5);
    expect(view.centreX).not.toBe(size.width / 2);
  });

  it("does not blow one pixel up to fill the screen", () => {
    const view = openingViewport({
      bounds: { minX: 100, minY: 100, maxX: 100, maxY: 100 },
      board: size,
      screen,
    });

    // Fitting one cell to 800px is 680x, which frames the work truthfully and
    // reads as broken.
    expect(view.scale).toBeLessThanOrEqual(12);
  });

  it("zooms out until wide activity fits, and stops before pixels vanish", () => {
    const wide = openingViewport({
      bounds: { minX: 0, minY: 0, maxX: 199, maxY: 199 },
      board: size,
      screen,
    });
    expect(wide.scale).toBeLessThan(12);
    expect(wide.scale).toBeGreaterThanOrEqual(2);
  });

  it("leaves margin around the activity rather than cropping it", () => {
    const bounds = { minX: 0, minY: 0, maxX: 99, maxY: 99 };
    const view = openingViewport({ bounds, board: size, screen });

    // 100 cells at this scale must fit inside the shorter side with room to
    // spare, or the framing crops the very thing it was aiming at.
    expect(100 * view.scale).toBeLessThan(screen.height);
  });
});

import { describe, expect, it } from "vitest";
import {
  TAP_SLOP_PX,
  clampToBoard,
  isTap,
  panBy,
  pixelAt,
  screenToBoard,
  zoomAt,
} from "../viewport";

const SCREEN = { width: 800, height: 600 };
const BOARD = { width: 200, height: 200 };
const CENTRED = { centreX: 100, centreY: 100, scale: 2 };

describe("viewport", () => {
  it("puts the viewport centre at the middle of the screen", () => {
    expect(screenToBoard(CENTRED, SCREEN, { x: 400, y: 300 })).toEqual({ x: 100, y: 100 });
  });

  it("converts screen to board at the current scale", () => {
    // 40 screen pixels right of centre, at 2x, is 20 board pixels.
    expect(screenToBoard(CENTRED, SCREEN, { x: 440, y: 300 })).toEqual({ x: 120, y: 100 });
  });

  it("keeps the board point under the cursor fixed while zooming", () => {
    // This is the whole contract of zoom-to-cursor: whatever you point at is
    // still under the pointer afterwards.
    const point = { x: 600, y: 200 };
    const before = screenToBoard(CENTRED, SCREEN, point);
    const zoomed = zoomAt(CENTRED, SCREEN, point, 2, { min: 1, max: 64 });
    const after = screenToBoard(zoomed, SCREEN, point);

    expect(after.x).toBeCloseTo(before.x, 6);
    expect(after.y).toBeCloseTo(before.y, 6);
    expect(zoomed.scale).toBe(4);
  });

  it("refuses to zoom past its limits", () => {
    expect(zoomAt(CENTRED, SCREEN, { x: 400, y: 300 }, 100, { min: 1, max: 8 }).scale).toBe(8);
    expect(zoomAt(CENTRED, SCREEN, { x: 400, y: 300 }, 0.001, { min: 1, max: 8 }).scale).toBe(1);
  });

  it("pans in board units, so a drag moves the same board distance at any zoom", () => {
    expect(panBy({ ...CENTRED, scale: 2 }, 10, 0).centreX).toBe(110);
  });

  it("keeps the viewport centre on the board", () => {
    expect(clampToBoard({ centreX: -50, centreY: 900, scale: 4 }, BOARD)).toEqual({
      centreX: 0,
      centreY: 200,
      scale: 4,
    });
  });

  it("floors a screen point to the pixel it lands in", () => {
    expect(pixelAt(CENTRED, SCREEN, { x: 401, y: 301 }, BOARD)).toEqual({ x: 100, y: 100 });
  });

  it("returns nothing for a point outside the board", () => {
    const farOut = { centreX: 0, centreY: 0, scale: 1 };
    expect(pixelAt(farOut, SCREEN, { x: 0, y: 0 }, BOARD)).toBeNull();
  });

  it("treats a small movement as a tap and a large one as a drag", () => {
    // Without this, every pan on a phone ends in an accidental pixel.
    expect(isTap(0)).toBe(true);
    expect(isTap(TAP_SLOP_PX - 1)).toBe(true);
    expect(isTap(TAP_SLOP_PX + 1)).toBe(false);
  });
});

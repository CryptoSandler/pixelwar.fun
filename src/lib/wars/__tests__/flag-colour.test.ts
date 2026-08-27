import { describe, expect, it } from "vitest";
import { BoardImage } from "../../canvas/board-image";
import {
  CANVAS_GROUND,
  MAX_TOKEN_SLOT,
  PALETTE,
  PALETTE_SIZE,
  colourForSlot,
  flagColourForSlot,
  flagRgba,
  rgba,
} from "../palette";

/**
 * A token's flag and a pixel's paint are two different questions now.
 *
 * They used to be one, which is why one function answered both. Migration 008
 * lets a war seat more tokens than the palette has colours, so the two answers
 * diverge: paint is strict (a byte outside the palette is corrupt and there is
 * no honest colour for it) and flags wrap (slot 25 is a real token and has to
 * look like something).
 *
 * These tests exist to stop the two being merged back together, which is the
 * obvious "simplification" and would hand one caller the other's policy.
 */
describe("flag colours vs painted colours", () => {
  it("agree for every slot the palette itself covers", () => {
    for (let slot = 0; slot <= PALETTE_SIZE; slot++) {
      expect(flagColourForSlot(slot)).toBe(colourForSlot(slot));
    }
  });

  it("wraps the palette past its last slot, where painting refuses to", () => {
    // Slot 25 is the 1st colour again. Two tokens, one flag — the documented
    // cost of a 24-colour palette, and the reason the admin screen says so.
    expect(flagColourForSlot(PALETTE_SIZE + 1)).toBe(PALETTE[0]);
    expect(flagColourForSlot(PALETTE_SIZE + 2)).toBe(PALETTE[1]);
    expect(flagColourForSlot(PALETTE_SIZE * 2)).toBe(PALETTE[PALETTE_SIZE - 1]);

    // The strict one does not follow it there.
    expect(() => colourForSlot(PALETTE_SIZE + 1)).toThrow(RangeError);
  });

  it("keeps slot 0 as the ground on both, and out of the palette", () => {
    expect(flagColourForSlot(0)).toBe(CANVAS_GROUND);
    expect(colourForSlot(0)).toBe(CANVAS_GROUND);
    expect(PALETTE.map((c) => c.toLowerCase())).not.toContain(CANVAS_GROUND.toLowerCase());
  });

  it("refuses a slot no war can seat", () => {
    expect(() => flagColourForSlot(MAX_TOKEN_SLOT + 1)).toThrow(RangeError);
    expect(() => flagColourForSlot(-1)).toThrow(RangeError);
    expect(() => flagColourForSlot(1.5)).toThrow(RangeError);
  });
});

describe("BoardImage across the two layers", () => {
  it("renders a token slot past the palette on the territory table", () => {
    const board = new BoardImage(2, 1, flagRgba());
    board.setBase(new Uint8Array([PALETTE_SIZE + 1, 0]));

    // Kept, not degraded to unpainted: this is a real token's real slot.
    expect(board.slotAt(0)).toBe(PALETTE_SIZE + 1);
  });

  it("degrades that same byte to unpainted on the colour table", () => {
    // THE LAYER-MISMATCH GUARD. The colour table cannot name slot 25, and the
    // failure is silent by design (a corrupt board becomes holes, not lies).
    // That policy is right for corruption and wrong for handing the wrong
    // table to the wrong layer, which is why the table is an argument.
    const board = new BoardImage(2, 1, rgba());
    board.setBase(new Uint8Array([PALETTE_SIZE + 1, 0]));

    expect(board.slotAt(0)).toBe(0);
  });
});

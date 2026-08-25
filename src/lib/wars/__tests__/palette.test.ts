import { describe, expect, it } from "vitest";
import { CANVAS_GROUND, PALETTE, PALETTE_SIZE, colourForSlot, rgba, rgbDistance } from "../palette";

// Slot 0 must be unmistakably "nobody has been here". A viewer should never
// have to wonder whether a region is empty or somebody's territory.
const MIN_GROUND_DISTANCE = 64;

describe("palette", () => {
  it("has exactly 24 token colours", () => {
    expect(PALETTE).toHaveLength(24);
    expect(PALETTE_SIZE).toBe(24);
  });

  it("has no duplicate token colours", () => {
    expect(new Set(PALETTE.map((c) => c.toLowerCase())).size).toBe(24);
  });

  it("uses well-formed hex everywhere", () => {
    for (const colour of [...PALETTE, CANVAS_GROUND]) {
      expect(colour).toMatch(/^#[0-9A-F]{6}$/);
    }
  });

  it("never assigns the canvas ground to a token", () => {
    expect(PALETTE.map((c) => c.toLowerCase())).not.toContain(CANVAS_GROUND.toLowerCase());
  });

  it("keeps the ground away from pure black and pure white", () => {
    // Both are real token colours, and an all-white board reads as a broken
    // render while an all-black one reads as nothing loaded.
    expect(CANVAS_GROUND).not.toBe("#000000");
    expect(CANVAS_GROUND).not.toBe("#FFFFFF");
  });

  it("keeps the ground far from every token colour", () => {
    for (const colour of PALETTE) {
      expect(rgbDistance(CANVAS_GROUND, colour)).toBeGreaterThanOrEqual(MIN_GROUND_DISTANCE);
    }
  });

  it("maps slot 0 to the ground and slots 1-24 to token colours", () => {
    expect(colourForSlot(0)).toBe(CANVAS_GROUND);
    expect(colourForSlot(1)).toBe(PALETTE[0]);
    expect(colourForSlot(24)).toBe(PALETTE[23]);
    expect(() => colourForSlot(25)).toThrow();
    expect(() => colourForSlot(-1)).toThrow();
  });

  it("exposes a slot-indexed RGBA table for the renderer", () => {
    const table = rgba();
    expect(table).toHaveLength(25 * 4);
    expect([table[0], table[1], table[2], table[3]]).toEqual([0x2e, 0x2e, 0x38, 255]);
    expect([table[4], table[5], table[6], table[7]]).toEqual([0xbe, 0x00, 0x39, 255]);
  });
});

import { describe, expect, it } from "vitest";
import { BoardImage } from "../board-image";
import { toRgb } from "../../wars/palette";

describe("BoardImage", () => {
  it("starts every pixel on the canvas ground", () => {
    const image = new BoardImage(4, 4);
    const [r, g, b] = toRgb("#2E2E38");
    expect([...image.rgbaBuffer.slice(0, 4)]).toEqual([r, g, b, 255]);
    expect(image.slotAt(0)).toBe(0);
  });

  it("paints the whole base in one go", () => {
    const image = new BoardImage(2, 2);
    image.setBase(new Uint8Array([1, 0, 13, 24]));

    expect(image.slotAt(0)).toBe(1);
    expect(image.slotAt(2)).toBe(13);
    const [r, g, b] = toRgb("#BE0039");
    expect([...image.rgbaBuffer.slice(0, 4)]).toEqual([r, g, b, 255]);
  });

  it("applies a single change without touching its neighbours", () => {
    const image = new BoardImage(2, 2);
    image.setBase(new Uint8Array([1, 1, 1, 1]));
    image.applyChange(2, 24);

    expect(image.slotAt(2)).toBe(24);
    expect(image.slotAt(1)).toBe(1);
    expect([...image.rgbaBuffer.slice(8, 12)]).toEqual([255, 255, 255, 255]);
  });

  it("returns a pixel to the ground when a change clears it", () => {
    const image = new BoardImage(2, 2);
    image.setBase(new Uint8Array([5, 5, 5, 5]));
    image.applyChange(0, 0);

    expect(image.slotAt(0)).toBe(0);
    const [r, g, b] = toRgb("#2E2E38");
    expect([...image.rgbaBuffer.slice(0, 4)]).toEqual([r, g, b, 255]);
  });

  it("ignores a change outside the board rather than corrupting the buffer", () => {
    const image = new BoardImage(2, 2);
    expect(() => image.applyChange(99, 3)).not.toThrow();
    expect(image.rgbaBuffer).toHaveLength(16);
  });

  it("rejects a base of the wrong size, which would silently shear the board", () => {
    const image = new BoardImage(2, 2);
    expect(() => image.setBase(new Uint8Array(3))).toThrow(/expected 4 bytes/);
  });
});

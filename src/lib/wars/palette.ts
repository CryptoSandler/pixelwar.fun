/**
 * Twenty-four token colours and the ground they sit on.
 *
 * The palette IS the attribution model. A canvas byte is a palette slot, a
 * palette slot is a token, so the board needs no second data structure to say
 * who owns what. Slot 0 means unpainted and belongs to no token.
 *
 * These are the r/place 2022 values, which the whole lineage of clones settled
 * on because they stay distinguishable at one-pixel size. Saying so plainly is
 * better than pretending otherwise. The visual design pass owns this list and
 * may replace it; the tests are the contract it has to keep.
 */

export const PALETTE = [
  "#BE0039", "#FF4500", "#FFA800", "#FFD635", "#FFF8B8", "#00A368",
  "#00CC78", "#7EED56", "#00756F", "#009EAA", "#00CCC0", "#2450A4",
  "#3690EA", "#51E9F4", "#493AC1", "#6A5CFF", "#811E9F", "#B44AC0",
  "#FF3881", "#FF99AA", "#6D482F", "#FFB470", "#000000", "#FFFFFF",
] as const;

export const PALETTE_SIZE = PALETTE.length;

/**
 * Slot 0: unpainted.
 *
 * A desaturated slate, and deliberately not a colour any token can hold — no
 * entry in PALETTE is grey — so empty space can only ever read as empty space.
 */
export const CANVAS_GROUND = "#2E2E38";

export function colourForSlot(slot: number): string {
  if (!Number.isInteger(slot) || slot < 0 || slot > PALETTE_SIZE) {
    throw new RangeError(`Colour slot ${slot} is outside 0..${PALETTE_SIZE}`);
  }
  return slot === 0 ? CANVAS_GROUND : PALETTE[slot - 1];
}

export function toRgb(hex: string): [number, number, number] {
  const value = Number.parseInt(hex.slice(1), 16);
  return [(value >> 16) & 255, (value >> 8) & 255, value & 255];
}

/** Straight-line distance in RGB. Crude, and enough to catch a collision. */
export function rgbDistance(a: string, b: string): number {
  const [ar, ag, ab] = toRgb(a);
  const [br, bg, bb] = toRgb(b);
  return Math.hypot(ar - br, ag - bg, ab - bb);
}

/** Slot-indexed RGBA, for painting an ImageData buffer without a lookup map. */
export function rgba(): Uint8ClampedArray {
  const table = new Uint8ClampedArray((PALETTE_SIZE + 1) * 4);
  for (let slot = 0; slot <= PALETTE_SIZE; slot++) {
    const [r, g, b] = toRgb(colourForSlot(slot));
    table.set([r, g, b, 255], slot * 4);
  }
  return table;
}

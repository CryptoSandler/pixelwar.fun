/**
 * Twenty-four colours anyone may paint in, and the ground they sit on.
 *
 * THE PALETTE IS NO LONGER THE ATTRIBUTION MODEL. It used to be: a canvas
 * byte was a palette slot, a palette slot was a token, and the board needed
 * no second structure to say who owned what. That is over — every painter may
 * use every colour, and who a pixel belongs to is carried by
 * `pixels.war_token_id`, which is a different question with a different
 * answer. See migration 007 and `canvas/state.ts`, where the two questions
 * became two layers.
 *
 * A token still HAS a slot in this list (`war_tokens.colour_slot`). It is its
 * flag: the colour that stands for it on the scoreboard and in the territory
 * view. It is no longer the colour of any particular pixel it owns, and a
 * board painted entirely in one colour is now an ordinary thing to see.
 *
 * Slot 0 means unpainted and belongs to nobody, which is the one part of the
 * old model that survives intact — and it is load-bearing in a new way now
 * that painters choose colours: it is the value `paintPixel` refuses, so
 * nobody can blank a pixel by painting the ground.
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

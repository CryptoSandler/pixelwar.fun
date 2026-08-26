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

/**
 * The maximum token slot a war can seat, and therefore the maximum value the
 * territory layer's byte can carry. 0 is reserved for unpainted.
 *
 * Not a preference — see migration 008. It is what one byte can name.
 */
export const MAX_TOKEN_SLOT = 255;

/**
 * A TOKEN's flag colour, which is not the same function as `colourForSlot`
 * and must not be merged with it.
 *
 * `colourForSlot` answers "what colour is this painted pixel" and is strict:
 * a slot outside 0..24 is a corrupt byte and throws, because there is no
 * honest colour to return for one. This answers "what colour stands for this
 * token", where slots run to `MAX_TOKEN_SLOT` and the palette has 24 entries,
 * so it WRAPS.
 *
 * The wrap is the visible cost of a 24-colour palette and is documented in
 * migration 008: past 24 tokens, two of them carry the same flag and are told
 * apart on the scoreboard by ticker. A war that wants every token visually
 * distinct keeps its admission cap at 24, which is still the default.
 *
 * Merging the two functions would mean one of the two callers silently gets
 * the other's policy — either a corrupt canvas byte quietly rendering as a
 * valid colour, or a legitimate 25th token throwing and taking a page down.
 */
export function flagColourForSlot(slot: number): string {
  if (!Number.isInteger(slot) || slot < 0 || slot > MAX_TOKEN_SLOT) {
    throw new RangeError(`Token slot ${slot} is outside 0..${MAX_TOKEN_SLOT}`);
  }
  if (slot === 0) return CANVAS_GROUND;
  return PALETTE[(slot - 1) % PALETTE_SIZE];
}

/**
 * Slot-indexed RGBA for the TERRITORY layer, covering every token slot a war
 * can seat rather than only the palette's own range.
 *
 * A separate table from `rgba()` because the two layers disagree about what a
 * byte means, and `BoardImage` rejects any byte its table cannot name. Handing
 * the colour layer's 25-entry table to the territory layer would silently
 * blank every pixel owned by a token past the 24th.
 */
export function flagRgba(): Uint8ClampedArray {
  const table = new Uint8ClampedArray((MAX_TOKEN_SLOT + 1) * 4);
  for (let slot = 0; slot <= MAX_TOKEN_SLOT; slot++) {
    const [r, g, b] = toRgb(flagColourForSlot(slot));
    table.set([r, g, b, 255], slot * 4);
  }
  return table;
}

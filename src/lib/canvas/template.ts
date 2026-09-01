import type { Point, Size } from "./viewport";

/**
 * The template overlay's arithmetic, with no DOM in it.
 *
 * WHAT A TEMPLATE IS, AND WHY THE SCALE IS FIXED AT 1:1. An overlay is a
 * picture of what a community intends to paint, laid over the board so
 * somebody can read a cell off it and place that pixel. One template pixel is
 * therefore one board cell, always: at any other ratio the thing you are
 * reading off is an interpolation, and "which colour goes in this cell" stops
 * having an answer. Both references' overlay scripts work this way.
 *
 * // ponytail: 1:1 only. If communities start wanting to sketch large and
 * // scale down, that is nearest-neighbour resampling into a cell grid and a
 * // second control, not a change to this function.
 *
 * NOTHING HERE TOUCHES A FILE, A CANVAS OR THE NETWORK. `docs/references.md`
 * has specified this feature as "entirely client-side... nothing uploaded,
 * nothing stored" since before the canvas was built, and the module that
 * decides where the picture sits is the part worth testing.
 */

/**
 * The largest template accepted, per side.
 *
 * A bound because the file comes from the visitor's own disk and a camera
 * photo is 4,000 pixels across — dropped on a 200-wide board it is nonsense,
 * and drawn every frame it is a stutter. 512 is comfortably larger than any
 * board this product runs and small enough to be free.
 */
export const TEMPLATE_MAX_SIDE = 512;

export type TemplateSize = Size;

/**
 * Keeps a template's top-left corner somewhere the template can be seen.
 *
 * TWO CASES, AND THE SECOND IS THE ONE THAT LOOKS WRONG UNTIL IT IS WRITTEN
 * DOWN. When the template FITS on the board, its corner ranges over
 * `0 .. board - template`, so the whole picture is always on the board and it
 * can never be nudged half off the edge.
 *
 * When the template is BIGGER than the board, that range inverts — the corner
 * ranges over `board - template .. 0`, which is negative to zero — and that is
 * correct rather than a bug: an oversized template is panned UNDER the board,
 * and every position in that range keeps the board completely covered. The
 * naive clamp to `0 .. board - template` would collapse to a single point and
 * make an oversized template unmovable.
 */
export function clampTemplate(at: Point, template: TemplateSize, board: Size): Point {
  const axis = (value: number, span: number, extent: number) => {
    const slack = span - extent;
    const low = Math.min(0, slack);
    const high = Math.max(0, slack);
    return Math.min(high, Math.max(low, Math.round(value)));
  };
  return {
    x: axis(at.x, board.width, template.width),
    y: axis(at.y, board.height, template.height),
  };
}

/**
 * Whether an image may be used as a template at all.
 *
 * Refuses rather than resizes. A community that dropped the wrong file needs
 * to be told, and silently shrinking a 4,000-pixel photo to fit would produce
 * a template whose cells are invented.
 */
export function templateTooLarge(template: TemplateSize): boolean {
  return template.width > TEMPLATE_MAX_SIDE || template.height > TEMPLATE_MAX_SIDE;
}

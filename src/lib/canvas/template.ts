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

/**
 * The most a stored template may weigh, as a data URL.
 *
 * `sessionStorage` is about 5MB per origin in every current browser, and it
 * is shared with anything else this origin ever wants to keep. Two megabytes
 * leaves room and is generous for a template: base64 costs about a third on
 * top of the file, so this is roughly a 1.5MB picture, and a template is a
 * small square.
 *
 * CHECKED BEFORE THE TEMPLATE IS ACCEPTED, not when saving fails. A picture
 * that appears on the board and then quietly does not come back after a
 * reload is exactly the defect this whole change exists to fix; refusing it
 * up front, with a message that says to make it smaller, is the only honest
 * order to do it in.
 */
export const TEMPLATE_MAX_DATA_URL_BYTES = 2 * 1024 * 1024;

/** What survives a reload. Deliberately small and deliberately not the bitmap. */
export type StoredTemplate = {
  /** The picture itself, as a data URL, so it needs nothing from the network. */
  dataUrl: string;
  x: number;
  y: number;
  opacity: number;
};

export function templateDataUrlTooLarge(dataUrl: string): boolean {
  return dataUrl.length > TEMPLATE_MAX_DATA_URL_BYTES;
}

/**
 * Reads back what was stored, or nothing.
 *
 * EVERY FIELD IS RE-VALIDATED, and `sessionStorage` being same-tab and
 * same-origin is not a reason to skip it. The value can have been written by
 * an older version of this code with a different shape, by a half-finished
 * write, or by a person with a console open. A restore that trusts the blob
 * puts an arbitrary string into an `<img>`-shaped hole.
 *
 * THE POSITION IS CLAMPED AGAINST THE BOARD BEING RESTORED ONTO, not the one
 * it was saved from. Wars are not all the same size, so a template placed at
 * (150, 150) in a 200x200 war would otherwise come back completely off the
 * edge of a 100x100 one and look like it had vanished.
 */
export function readStoredTemplate(raw: string | null, board: Size): StoredTemplate | null {
  if (!raw) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;

  const value = parsed as Partial<StoredTemplate>;
  const { dataUrl, x, y, opacity } = value;

  // Only a data URL, and only one that claims to be an image. This string is
  // about to become an `<img>`'s src: `javascript:` and `http:` are both
  // things a hand-written entry could contain, and neither is a template.
  if (typeof dataUrl !== "string" || !/^data:image\/[a-z0-9.+-]+;base64,/i.test(dataUrl)) {
    return null;
  }
  if (templateDataUrlTooLarge(dataUrl)) return null;
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
  if (!Number.isFinite(opacity) || opacity! <= 0 || opacity! > 1) return null;

  // Clamped with the STORED template's own size unknown at this point — the
  // bitmap has not been decoded yet — so the caller clamps again once it has.
  // This bound only keeps a wild number out of the DOM.
  return {
    dataUrl,
    x: Math.round(Math.max(-board.width, Math.min(board.width, x!))),
    y: Math.round(Math.max(-board.height, Math.min(board.height, y!))),
    opacity: opacity!,
  };
}

import type { Size, Viewport } from "./viewport";

/**
 * Where the painted pixels actually are.
 *
 * An almost-empty board is the state this exists for, and it is the state a
 * war spends its first hours in. Opening it at 3x centred on the geometric
 * middle of a 200x200 plane shows a visitor forty thousand empty cells and
 * whatever handful of pixels exist somewhere off in the grey — which answers
 * "what is happening on this board" with "nothing", even when something is.
 *
 * So the opening view is framed on the work rather than on the coordinate
 * space. Nothing here knows about the DOM; it is arithmetic over the slot
 * buffer, which is why it can be tested rather than eyeballed.
 */

export type Bounds = { minX: number; minY: number; maxX: number; maxY: number };

/**
 * The tightest box containing every painted pixel, or `null` for a board with
 * none.
 *
 * `null` rather than a zero-sized box at the origin: "there is no activity" is
 * a different fact from "the activity is one pixel at (0,0)", and the caller
 * frames those two differently.
 */
export function activityBounds(
  slots: Uint8Array,
  width: number,
  height: number,
): Bounds | null {
  let minX = width;
  let minY = height;
  let maxX = -1;
  let maxY = -1;

  for (let idx = 0; idx < slots.length; idx++) {
    if (slots[idx] === 0) continue;
    const x = idx % width;
    const y = (idx / width) | 0;
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  }

  return maxX < 0 ? null : { minX, minY, maxX, maxY };
}

/**
 * The viewport a war should open at.
 *
 * Three cases, and each is a different answer to "what is worth looking at":
 *
 * - NO ACTIVITY. Centre the board and open close enough that the grid is
 *   legible, because on an empty board the grid IS the content — it is the
 *   only thing that says "this is a surface you can paint on" rather than
 *   "this page failed to load". `emptyScale` is above the grid threshold on
 *   purpose.
 * - ACTIVITY. Centre its bounding box and fit it, with margin, into whatever
 *   space the board element has. The scale is clamped: a single painted pixel
 *   would otherwise fill the screen at 200x, which frames the work
 *   truthfully and reads as broken.
 * - ACTIVITY WIDER THAN THE BOARD ELEMENT. Falls out of the same arithmetic —
 *   the fit scale drops until the box fits, and the clamp's lower bound stops
 *   it below the point where individual pixels stop being visible at all.
 */
export function openingViewport(input: {
  bounds: Bounds | null;
  board: Size;
  screen: Size;
  /** Fraction of the element left as breathing room around the activity. */
  margin?: number;
  minScale?: number;
  maxScale?: number;
  emptyScale?: number;
}): Viewport {
  const {
    bounds,
    board,
    screen,
    margin = 0.15,
    minScale = 2,
    maxScale = 12,
    emptyScale = 9,
  } = input;

  if (!bounds) {
    return { centreX: board.width / 2, centreY: board.height / 2, scale: emptyScale };
  }

  // +1 because the bounds are inclusive: a box from x=4 to x=4 is one pixel
  // wide, not zero, and a zero width would divide the fit scale to Infinity.
  const spanX = bounds.maxX - bounds.minX + 1;
  const spanY = bounds.maxY - bounds.minY + 1;

  const usable = 1 - margin;
  const fit = Math.min(
    (screen.width * usable) / spanX,
    (screen.height * usable) / spanY,
  );

  return {
    // +0.5 puts the centre in the middle of the pixel rather than on its
    // top-left corner, which is a half-pixel offset that shows at high zoom.
    centreX: (bounds.minX + bounds.maxX) / 2 + 0.5,
    centreY: (bounds.minY + bounds.maxY) / 2 + 0.5,
    scale: Math.max(minScale, Math.min(maxScale, fit)),
  };
}

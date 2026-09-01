/**
 * Zoom, pan, and the screen-to-board conversion, with no DOM in sight.
 *
 * Kept pure so the fiddly part — the part where a zoom drifts by half a pixel
 * and nobody can say why — is unit tested instead of eyeballed.
 */

/**
 * How far in the board may be zoomed, and the canonical values.
 *
 * Here rather than in `Board.tsx` because two things now need them: the
 * gesture handlers, and the deep-link parser below, which must clamp a `z`
 * somebody typed into the same range a pinch can reach. A second copy of
 * these numbers is a link that opens at a zoom no gesture can produce.
 */
export const ZOOM_LIMITS = { min: 1, max: 48 } as const;

export type Size = { width: number; height: number };
export type Point = { x: number; y: number };
export type Viewport = { centreX: number; centreY: number; scale: number };

/**
 * How far a pointer may travel and still count as a tap.
 *
 * Every pan on a touchscreen ends with a pointerup somewhere on the canvas. If
 * that always painted, the board would fill with pixels nobody meant to place.
 */
export const TAP_SLOP_PX = 8;

export function isTap(totalMovement: number): boolean {
  return totalMovement <= TAP_SLOP_PX;
}

export function boardToScreen(v: Viewport, screen: Size, board: Point): Point {
  return {
    x: screen.width / 2 + (board.x - v.centreX) * v.scale,
    y: screen.height / 2 + (board.y - v.centreY) * v.scale,
  };
}

export function screenToBoard(v: Viewport, screen: Size, point: Point): Point {
  return {
    x: v.centreX + (point.x - screen.width / 2) / v.scale,
    y: v.centreY + (point.y - screen.height / 2) / v.scale,
  };
}

/** The pixel a screen point lands in, or null when it lands off the board. */
export function pixelAt(v: Viewport, screen: Size, point: Point, board: Size): Point | null {
  const { x, y } = screenToBoard(v, screen, point);
  const px = Math.floor(x);
  const py = Math.floor(y);
  if (px < 0 || py < 0 || px >= board.width || py >= board.height) return null;
  return { x: px, y: py };
}

/** Zooms about a screen point, leaving whatever is under it exactly where it is. */
export function zoomAt(
  v: Viewport,
  screen: Size,
  point: Point,
  factor: number,
  limits: { min: number; max: number },
): Viewport {
  const scale = Math.min(limits.max, Math.max(limits.min, v.scale * factor));
  if (scale === v.scale) return v;

  const anchor = screenToBoard(v, screen, point);
  const offsetX = point.x - screen.width / 2;
  const offsetY = point.y - screen.height / 2;

  return {
    scale,
    centreX: anchor.x - offsetX / scale,
    centreY: anchor.y - offsetY / scale,
  };
}

export function panBy(v: Viewport, dxBoard: number, dyBoard: number): Viewport {
  return { ...v, centreX: v.centreX + dxBoard, centreY: v.centreY + dyBoard };
}

/** Keeps the centre on the board, so the canvas cannot be lost off-screen. */
export function clampToBoard(v: Viewport, board: Size): Viewport {
  return {
    ...v,
    centreX: Math.min(board.width, Math.max(0, v.centreX)),
    centreY: Math.min(board.height, Math.max(0, v.centreY)),
  };
}

/**
 * A link to a place on the board.
 *
 * WHY THIS IS A PURE FUNCTION WITH ITS OWN TEST FILE. A deep link is the one
 * piece of this interface a stranger constructs by hand — from a chat client
 * that mangled it, a screenshot somebody retyped, or an old link to a board
 * that has since been resized. The parser is therefore handed hostile input
 * as a matter of course, and it has no DOM, no network and no database in it,
 * so every one of those cases is a unit test rather than a thing somebody
 * eyeballs once.
 *
 * WHAT IT REFUSES, AND WHAT IT FORGIVES. `x` and `y` are the address and are
 * strict: both must be present, both must be plain integers, and both must
 * land on the board this war actually has. Anything else yields `null` and
 * the caller frames the board the way it would with no link at all — a link
 * to a pixel that does not exist is not a weaker request, it is a different
 * board.
 *
 * `z` is a preference and is forgiving: absent, malformed or out of range, it
 * falls back to `LINK_SCALE` rather than throwing the whole link away.
 * Somebody who lost the zoom off the end of a URL still meant the place.
 */
export const LINK_SCALE = 12;

/** Plain integers only. Rejects "1e3", "+1", "0x10", "1.5", "NaN", "١٢". */
const INTEGER = /^-?\d+$/;
/** Positive decimals only. Rejects the same, plus negatives and exponents. */
const DECIMAL = /^\d+(\.\d+)?$/;

export type PlaceParams = {
  x?: string | null;
  y?: string | null;
  z?: string | null;
};

/**
 * The viewport a `?x=&y=&z=` link asks for, or `null` when it does not ask
 * for one this board can honour.
 *
 * The returned centre is the MIDDLE of the addressed pixel, not its top-left
 * corner — the same half-pixel `openingViewport` adds, and for the same
 * reason: at high zoom the difference is visible, and a link that lands half
 * a cell off is a link that points at the wrong pixel.
 *
 * Not clamped here. `clampToBoard` is the caller's step, because the clamp
 * needs the screen it is being fitted into and this function deliberately
 * knows nothing about a screen.
 */
export function viewportFromParams(params: PlaceParams, board: Size): Viewport | null {
  const x = readInteger(params.x);
  const y = readInteger(params.y);
  if (x === null || y === null) return null;
  if (x < 0 || y < 0 || x >= board.width || y >= board.height) return null;

  return { centreX: x + 0.5, centreY: y + 0.5, scale: readScale(params.z) };
}

/**
 * The link back to wherever the view is now.
 *
 * The PIXEL AT THE CENTRE, not the centre itself: a link carries a place on
 * the board, and a place on this board is a cell. Rounding to a cell also
 * makes the link stable — two people who panned to visibly the same spot get
 * the same URL, rather than two that differ in the fourth decimal.
 *
 * Clamped into the board because a viewport centre legitimately sits on the
 * far edge (`clampToBoard` allows exactly `board.width`), and `width` is one
 * past the last column.
 */
export function paramsForViewport(v: Viewport, board: Size): { x: string; y: string; z: string } {
  const cell = (centre: number, span: number) =>
    String(Math.min(span - 1, Math.max(0, Math.floor(centre))));
  return {
    x: cell(v.centreX, board.width),
    y: cell(v.centreY, board.height),
    // One decimal, and trailing zeros trimmed: it matches what the readout
    // shows ("3.0x") without putting "3.0" in a URL people paste into chat.
    z: String(Math.round(v.scale * 10) / 10),
  };
}

function readInteger(raw: string | null | undefined): number | null {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  if (!INTEGER.test(trimmed)) return null;
  const value = Number(trimmed);
  // The regex already excludes every non-finite spelling; this is the belt to
  // its braces, and it also catches an integer too large to be exact.
  return Number.isSafeInteger(value) ? value : null;
}

function readScale(raw: string | null | undefined): number {
  if (typeof raw !== "string") return LINK_SCALE;
  const trimmed = raw.trim();
  if (!DECIMAL.test(trimmed)) return LINK_SCALE;
  const value = Number(trimmed);
  if (!Number.isFinite(value) || value <= 0) return LINK_SCALE;
  return Math.min(ZOOM_LIMITS.max, Math.max(ZOOM_LIMITS.min, value));
}

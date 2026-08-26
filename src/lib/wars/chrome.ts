/**
 * The chrome palette: every colour the interface paints that is NOT a token.
 *
 * The canvas and the chrome are two separate colour systems on one screen, and
 * the whole design rests on never confusing them. The twenty-four in
 * `PALETTE` belong to tokens; a community's colour is its identity and its
 * scoreboard. Anything here — a button, a panel, a border — belongs to the
 * application. If a chrome colour is mistakable for a token colour, the
 * interface is quietly claiming a seat it never paid for.
 *
 * Direction C ("Cabinet"). See DESIGN.md, whose invariants this file exists to
 * make testable.
 */

import { PALETTE, CANVAS_GROUND, rgbDistance } from "./palette";

/**
 * How far a chrome colour must sit from every token colour before we call it
 * unmistakable, as plain RGB euclidean distance.
 *
 * 80 is not arbitrary. Sweeping the whole 24-bit cube against this palette,
 * ordinary "brand" accents fail badly: Miro's canary #FFD02F lands 8 units
 * from token slot 4, which is the same colour to any eye that is not
 * measuring. Of twelve hand-picked candidates only two cleared 80. The
 * threshold is set where a colour stops being arguable.
 */
export const CHROME_TOKEN_DISTANCE = 80;

/**
 * Every surface chrome draws a token chip on top of.
 *
 * A chip is the small filled square that stands for a token in the leaderboard
 * and in the paint bar. It appears on each of these and nowhere else; adding a
 * surface here without checking it against the invariant below is the mistake
 * this list exists to prevent.
 */
export const CHROME_SURFACES = {
  surround: "#A8B1C6",
  panel: "#DEDEDE",
  control: "#DEDEDE",
  readout: "#AEC0DE",
  header: "#21242E",
  board: CANVAS_GROUND,
} as const;

/**
 * The signature accent. Everything the application asks you to do is this
 * colour, and nothing else is.
 *
 * Brass clears the token palette by 90 — its nearest neighbour is #FFA800,
 * which is a much brighter orange. It is also the loudest thing in the chrome
 * on purpose: one accent, used only for the primary action, cannot be confused
 * with a token because no token ever appears as a large filled control.
 */
export const ACCENT = "#B87A1E";

/**
 * The outline every token chip carries, per surface it is drawn on.
 *
 * This is the fix for a failure that is invisible until it happens: a token
 * whose colour matches the chrome behind it disappears. The r/place palette
 * contains both #FFFFFF and #000000, so ANY chrome — light or dark — makes one
 * of the twenty-four vanish unless something separates the chip from its
 * background. An earlier direction with warm-white chrome erased its white
 * token entirely, in the leaderboard and the paint bar at once, and the render
 * is what caught it.
 *
 * A fill cannot solve this, because the fill is the token's own colour and is
 * not ours to change. The outline can, because it is ours.
 */
export const CHIP_OUTLINE: Record<keyof typeof CHROME_SURFACES, string> = {
  surround: "#21242E",
  panel: "#21242E",
  control: "#21242E",
  readout: "#21242E",
  header: "#F2F3F7",
  board: "#F2F3F7",
};

/**
 * Contrast a chip outline must reach against the surface behind it.
 *
 * Deliberately lower than `CHROME_TOKEN_DISTANCE`: the outline is not trying
 * to be unmistakable from a token, it is trying to be *seen*. 80 at one pixel
 * wide is a stricter test than the eye applies.
 */
export const OUTLINE_SURFACE_DISTANCE = 60;

/**
 * The chrome colours that carry meaning by being *coloured* — the ones a
 * viewer could read as a claim.
 *
 * Only these owe the palette a wide berth. Applying `CHROME_TOKEN_DISTANCE` to
 * every chrome colour is a rule that sounds stronger and is actually wrong:
 * neutrals cannot obey it. A light panel is near #FFFFFF and a dark header is
 * near #000000 because the palette contains pure white and pure black, and
 * `CANVAS_GROUND` itself — already agreed, already correct — sits 69 from
 * #6D482F. A rule the design's own settled decisions fail is not a strict
 * rule, it is a broken one. What actually protects a token is that no
 * *saturated, deliberate* chrome colour impersonates it, plus the outline
 * guarantee below for the neutrals.
 */
export function signatureColours(): string[] {
  return [ACCENT, CHROME_SURFACES.surround, CHROME_SURFACES.readout];
}

/**
 * Chroma ceiling for a chrome surface, as a fraction of full saturation.
 *
 * Derived, not chosen: the least saturated token that is a colour at all
 * (#FFF8B8, the pale yellow) sits at 0.243. A surface quieter than the
 * quietest real token cannot out-shout the board. Pure black and pure white
 * are excluded from that minimum — they are achromatic, so they would pin the
 * ceiling at zero and forbid every surface including the ones already in use.
 */
export function quietestChromaticToken(): number {
  const chromas = PALETTE.map(chroma).filter((c) => c > 0);
  return Math.min(...chromas);
}

/** Saturation of `hex` as a 0..1 fraction, the plain HSV definition. */
export function chroma(hex: string): number {
  const [r, g, b] = [1, 3, 5].map((i) => Number.parseInt(hex.slice(i, i + 2), 16));
  return (Math.max(r, g, b) - Math.min(r, g, b)) / 255;
}

/** The nearest token colour to `hex`, and how far away it is. */
export function nearestToken(hex: string): { colour: string; distance: number } {
  let colour: string = PALETTE[0];
  let distance = Number.POSITIVE_INFINITY;
  for (const token of PALETTE) {
    const d = rgbDistance(hex, token);
    if (d < distance) {
      distance = d;
      colour = token;
    }
  }
  return { colour, distance };
}

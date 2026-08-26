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
 * Brass clears the token palette by 100 — its nearest neighbour is #FFA800,
 * which is a much brighter orange. It is also the loudest thing in the chrome
 * on purpose: one accent, used only for the primary action, cannot be confused
 * with a token because no token ever appears as a large filled control.
 *
 * The first brass here was #B87A1E, and it was wrong for a reason no colour
 * measurement catches: at 4.31:1 against the ink it sits on, the primary
 * button's own label failed WCAG AA. Distance from the palette and contrast
 * with your own text are separate tests and a colour has to pass both. This
 * one is lighter, reads 5.19:1, and is further from the palette than its
 * predecessor rather than closer.
 */
export const ACCENT = "#B1923B";

/**
 * The three inks, and the surfaces each one is allowed on.
 *
 * `INK` and `INK_INVERSE` are not new colours — they are the header and panel
 * surfaces read back as text, which is why they carry no second literal. The
 * one that is its own colour is `MUTED_INK`, and it exists because of a bug
 * this file is the right place to make impossible: quieter text was expressed
 * as `opacity` on the ink, which silently turns a measured contrast into an
 * unmeasured one. `#21242E` at 80% over the readout renders 5.37:1 against a
 * stated floor of 8:1, and nothing in the code says so — the colour still
 * passes its own test while the element on screen does not.
 *
 * So de-emphasis is a colour here, not a filter, and it is measured like every
 * other colour. `MUTED_INK` is only declared for the surfaces in
 * `MUTED_INK_SURFACES`, and that list is short for a reason worth stating: at
 * §9's floors there is no headroom anywhere else. The readout demands 8:1 and
 * `INK` itself only reaches 8.40, the surround demands 7:1 and `INK` reaches
 * 7.20. A muted ink is lighter by definition, so on those two surfaces there
 * is no quieter colour that still clears the floor — quiet text simply does
 * not belong there, and the test below asserts that rather than leaving it as
 * a habit.
 */
export const INK = CHROME_SURFACES.header;
export const INK_INVERSE = CHROME_SURFACES.panel;

/** Body text that is deliberately quieter. 7.81:1 on a panel; see above. */
export const MUTED_INK = "#3A3F4D";

/**
 * Where `MUTED_INK` may be used. Adding a surface here without checking it
 * against `BODY_TEXT_CONTRAST` is the mistake this list exists to prevent —
 * the same job `CHIP_OUTLINE`'s completeness test does for chips.
 */
export const MUTED_INK_SURFACES = ["panel", "control"] as const satisfies readonly (keyof typeof CHROME_SURFACES)[];

/**
 * A disabled control's label, on the same two faces.
 *
 * Its own colour for the same reason `MUTED_INK` is: the alternative was
 * `opacity: 0.5`, which composited the label to 2.89:1 and said so nowhere.
 * WCAG exempts disabled controls from its text floor, so the number here is
 * not §9's — but "exempt" is a reason to choose the value deliberately, not a
 * reason to leave it unmeasured. 3.57:1 on a control face: plainly quieter
 * than `MUTED_INK`'s 7.81, plainly still readable.
 */
export const DISABLED_INK = "#6B7285";

/**
 * Quiet text on a DARK surface — the inverse of `MUTED_INK`, and needed for
 * exactly the same reason `INK_INVERSE` is needed beside `INK`.
 *
 * `MUTED_INK` is a dark ink for light faces and cannot cross: it reads 1.89:1
 * on the board's own chrome, which is not a quieter colour, it is an invisible
 * one. So the quiet step exists twice, once per polarity, and both halves are
 * measured.
 *
 * 7.26:1 on the lightest surface it is drawn on and 9.70:1 on the darkest —
 * over §9's body floor of 7 on all of them, and roughly half the contrast of
 * the ink it is quieting, so the de-emphasis is something a reader can
 * actually see. Low chroma, in the same blue-grey family as the rest of the
 * chrome, so it survives the board being restyled to direction C.
 */
export const MUTED_INK_INVERSE = "#B0B5C2";

/**
 * The dark surfaces the board UI draws on today.
 *
 * These are **Batch A Tailwind values**, not design decisions: `zinc-950` on
 * the shell, `zinc-800` in the board well, and black at 80% over `zinc-800`
 * for the two overlays — the last one derived, since the compositor is what
 * produces it and `#080808` is what it measures. They are recorded here for
 * one purpose only: text drawn on a surface nobody wrote down is text nobody
 * can measure, and this batch is replacing six composited opacities on
 * exactly these three.
 *
 * Deliberately NOT in `CHROME_SURFACES`. That list is the design's own
 * surfaces and everything in it owes I2 an outline and I4 a chroma ceiling;
 * these were chosen by a batch that predates DESIGN.md and claiming them
 * would say the design picked them. They go away when the board is restyled,
 * and so does this constant.
 */
export const BOARD_SURFACES = {
  shell: "#09090B",
  well: "#27272A",
  overlay: "#080808",
} as const;

/**
 * The primary button when it cannot be pressed.
 *
 * A face of its own rather than the accent run through a filter, which is
 * what this used to be: `filter: grayscale(0.7) brightness(0.9)` rendered
 * `#8C846C` carrying `#202023` at 4.33:1, and nothing anywhere recorded
 * either value. `opacity` and `filter` hide a number equally well — the rule
 * was never about one mechanism, it is that a rendered colour nobody measured
 * is not a decision.
 *
 * Chosen against three constraints, not one. It carries `INK` at 4.85:1, over
 * AA and deliberately *under* the accent's 5.19 — a dead key should not read
 * as more legible than a live one. It is achromatic, so the largest filled
 * control on the screen cannot be mistaken for a token, which is the same
 * worry I5 has about the accent. And its chroma is far below the accent's, so
 * "you can act" stays the loudest thing on screen and a disabled button never
 * competes for it.
 */
export const DISABLED_FACE = "#909090";

/** DESIGN.md §9's floors, as numbers something can be tested against. */
export const READOUT_TEXT_CONTRAST = 8;
export const BODY_TEXT_CONTRAST = 7;

/**
 * The floor for text that is deliberately out of reach. WCAG 1.4.11's
 * threshold for a graphical object rather than 1.4.3's for text, which
 * disabled controls are exempt from — the point of a number here is that the
 * quiet end of the scale has a bottom at all.
 */
export const DISABLED_TEXT_CONTRAST = 3;

/**
 * Every surface a token chip is drawn on, of either polarity.
 *
 * `CHROME_SURFACES` and `BOARD_SURFACES` are kept apart for the rules that
 * genuinely differ — a Batch A dark face has no business answering §4's
 * chroma ceiling or I1's distance rule, because the design did not choose it.
 * **Chip visibility is not one of those rules.** A token that vanishes into
 * the surface behind it vanishes just as completely on a surface nobody
 * designed, and the leaderboard rail draws all twenty-four on `zinc-950`
 * today. So I2 asks this list, not `CHROME_SURFACES`, and the hole that let a
 * chip be drawn with no outline at all closes.
 */
export const CHIP_SURFACES = { ...CHROME_SURFACES, ...BOARD_SURFACES } as const;

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
export const CHIP_OUTLINE: Record<keyof typeof CHIP_SURFACES, string> = {
  surround: "#21242E",
  panel: "#21242E",
  control: "#21242E",
  readout: "#21242E",
  header: "#F2F3F7",
  board: "#F2F3F7",
  // The board's own three, all dark, so all take the light outline the header
  // takes. The rail draws every token in the war on `shell`; without an entry
  // here #000000 was a black square on a #09090B ground — the exact failure
  // this constant exists for, one surface further out than anybody had
  // looked, and invisible to I2 for as long as I2 only asked
  // `CHROME_SURFACES`.
  shell: "#F2F3F7",
  well: "#F2F3F7",
  overlay: "#F2F3F7",
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

/** WCAG relative luminance of `hex`. */
function luminance(hex: string): number {
  const channels = [1, 3, 5].map((i) => Number.parseInt(hex.slice(i, i + 2), 16) / 255);
  const linear = channels.map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  return 0.2126 * linear[0] + 0.7152 * linear[1] + 0.0722 * linear[2];
}

/**
 * WCAG contrast ratio between two colours, 1..21.
 *
 * Here because a chrome colour has to pass two unrelated tests: far enough
 * from the palette that it cannot be read as a token, and legible under the
 * text it carries. The first accent chosen for this design passed the first
 * and failed the second, and nothing in the colour-distance work would ever
 * have noticed.
 */
export function contrastRatio(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

/** Smallest contrast WCAG AA accepts for normal-size text. */
export const AA_NORMAL_TEXT = 4.5;

/**
 * The design invariants, as assertions.
 *
 * DESIGN.md states these in prose. This file is why the prose is worth
 * anything: a colour swapped for a prettier one that happens to collide fails
 * here, at the moment it is introduced, instead of surviving to production and
 * making a real community's token unreadable.
 *
 * No database, so no per-test timeout is needed.
 */

import { describe, expect, it } from "vitest";
import { PALETTE, CANVAS_GROUND, rgbDistance } from "../palette";
import {
  AA_NORMAL_TEXT,
  ACCENT,
  BODY_TEXT_CONTRAST,
  CHIP_OUTLINE,
  DISABLED_INK,
  DISABLED_TEXT_CONTRAST,
  INK,
  MUTED_INK,
  MUTED_INK_SURFACES,
  READOUT_TEXT_CONTRAST,
  contrastRatio,
  CHROME_SURFACES,
  CHROME_TOKEN_DISTANCE,
  OUTLINE_SURFACE_DISTANCE,
  chroma,
  nearestToken,
  quietestChromaticToken,
  signatureColours,
} from "../chrome";

describe("the chrome never claims a token's colour", () => {
  it("keeps every deliberately coloured chrome surface clear of all twenty-four", () => {
    const offenders = signatureColours()
      .map((c) => ({ chrome: c, ...nearestToken(c) }))
      .filter((x) => x.distance < CHROME_TOKEN_DISTANCE);

    expect(
      offenders.map((o) => `${o.chrome} is ${Math.round(o.distance)} from token ${o.colour}`),
    ).toEqual([]);
  });

  it("does not pretend the neutrals can obey that rule", () => {
    // CANVAS_GROUND is settled and correct, and it sits 69 from #6D482F. If a
    // future edit widens signatureColours() to include the neutrals, this
    // catches it before the suite fills with unfixable failures.
    expect(nearestToken(CANVAS_GROUND).distance).toBeLessThan(CHROME_TOKEN_DISTANCE);
    expect(signatureColours()).not.toContain(CANVAS_GROUND);
  });

  it("keeps the accent clear by a margin, since it is the loudest chrome there is", () => {
    expect(nearestToken(ACCENT).distance).toBeGreaterThanOrEqual(CHROME_TOKEN_DISTANCE);
  });

  it("rejects a colliding accent — the guard actually fires", () => {
    // Miro's canary, measured at 8 units from slot 4. If this ever passes,
    // the threshold has been loosened into uselessness.
    expect(nearestToken("#FFD02F").distance).toBeLessThan(CHROME_TOKEN_DISTANCE);
  });
});

describe("every token chip is visible on every surface chrome draws it on", () => {
  const surfaces = Object.keys(CHROME_SURFACES) as (keyof typeof CHROME_SURFACES)[];

  it.each(surfaces)("gives the chip a visible edge on the %s surface", (surface) => {
    const distance = rgbDistance(CHIP_OUTLINE[surface], CHROME_SURFACES[surface]);
    expect(distance).toBeGreaterThanOrEqual(OUTLINE_SURFACE_DISTANCE);
  });

  it("covers the two tokens that would otherwise disappear", () => {
    // #FFFFFF vanishes on light chrome and #000000 on dark. Both are real
    // palette entries, so both cases are reachable by a real war.
    for (const token of ["#FFFFFF", "#000000"]) {
      expect(PALETTE).toContain(token);
      for (const surface of surfaces) {
        const fillHides = rgbDistance(token, CHROME_SURFACES[surface]) < OUTLINE_SURFACE_DISTANCE;
        const outlineSaves =
          rgbDistance(CHIP_OUTLINE[surface], CHROME_SURFACES[surface]) >= OUTLINE_SURFACE_DISTANCE;
        // Either the fill separates on its own, or the outline does. Never neither.
        expect(fillHides && !outlineSaves).toBe(false);
      }
    }
  });

  it("names an outline for every surface, so a new surface cannot be added silently", () => {
    expect(Object.keys(CHIP_OUTLINE).sort()).toEqual(surfaces.slice().sort());
  });
});

describe("the empty pixel reads as empty", () => {
  it("is no token's colour", () => {
    expect(PALETTE).not.toContain(CANVAS_GROUND);
    expect(nearestToken(CANVAS_GROUND).distance).toBeGreaterThan(0);
  });

  it("is neither pure white nor pure black", () => {
    expect(CANVAS_GROUND).not.toBe("#FFFFFF");
    expect(CANVAS_GROUND).not.toBe("#000000");
  });

  it("is a neutral — no token is grey, so grey can only mean unpainted", () => {
    const [r, g, b] = [1, 3, 5].map((i) => Number.parseInt(CANVAS_GROUND.slice(i, i + 2), 16));
    const chroma = (Math.max(r, g, b) - Math.min(r, g, b)) / 255;
    expect(chroma).toBeLessThan(0.1);
  });
});

describe("the chrome never out-shouts the canvas", () => {
  it("holds every surface under the chroma of the quietest real token", () => {
    // The surround covers more screen than anything else, so it is the one
    // that can drown the board. Bounded by the palette's own least saturated
    // colour rather than by an absolute figure — and by the least saturated
    // one that IS a colour, since #000000 and #FFFFFF would pin it at zero.
    const ceiling = quietestChromaticToken();
    expect(ceiling).toBeGreaterThan(0);
    for (const [name, colour] of Object.entries(CHROME_SURFACES)) {
      expect(chroma(colour), `${name} (${colour})`).toBeLessThan(ceiling);
    }
  });

  it("allows the accent more chroma than a surface, because it is small", () => {
    expect(chroma(ACCENT)).toBeGreaterThan(chroma(CHROME_SURFACES.surround));
  });
});

describe("a chrome colour is legible under the text it carries", () => {
  // Distance from the palette and contrast with your own label are unrelated
  // tests, and the design's first accent passed one while failing the other:
  // #B87A1E cleared the tokens by 90 and read 4.31:1 against the ink on the
  // primary button. Colour-distance work would never have caught it.
  it("carries the primary button's label at AA", () => {
    expect(contrastRatio(ACCENT, CHROME_SURFACES.header)).toBeGreaterThanOrEqual(AA_NORMAL_TEXT);
  });

  it("rejects the accent that failed — the guard actually fires", () => {
    expect(contrastRatio("#B87A1E", CHROME_SURFACES.header)).toBeLessThan(AA_NORMAL_TEXT);
  });

  it("holds readout and body text well above the floor, per DESIGN.md §9", () => {
    expect(contrastRatio(INK, CHROME_SURFACES.readout)).toBeGreaterThanOrEqual(READOUT_TEXT_CONTRAST);
    expect(contrastRatio(INK, CHROME_SURFACES.panel)).toBeGreaterThanOrEqual(BODY_TEXT_CONTRAST);
    expect(contrastRatio(INK, CHROME_SURFACES.surround)).toBeGreaterThanOrEqual(BODY_TEXT_CONTRAST);
  });

  // De-emphasis is a colour, never opacity on the ink. Opacity turns a
  // measured value into an unmeasured one and does it invisibly: #21242E at
  // 80% over the readout renders 5.37:1 against a stated floor of 8:1, and
  // the colour still passes every test in this file while the element on
  // screen fails. These cases exist so the quiet ink is measured too.
  it("carries body text at the floor on every surface it is allowed on", () => {
    // Without this the loop below asserts nothing at all if the list is ever
    // emptied, and an empty list is exactly what a careless "fix" to a failing
    // surface case would produce.
    expect(MUTED_INK_SURFACES.length).toBeGreaterThan(0);
    for (const surface of MUTED_INK_SURFACES) {
      expect(contrastRatio(MUTED_INK, CHROME_SURFACES[surface])).toBeGreaterThanOrEqual(
        BODY_TEXT_CONTRAST,
      );
    }
  });

  it("is not allowed on the surfaces where it would not clear the floor", () => {
    // The control that keeps MUTED_INK_SURFACES honest rather than decorative.
    // The readout and the surround are excluded because they have no headroom
    // at all — INK itself reads 8.40 against a floor of 8, and 7.20 against a
    // floor of 7 — so any lighter ink fails there, and this asserts it does.
    expect(MUTED_INK_SURFACES).not.toContain("readout");
    expect(MUTED_INK_SURFACES).not.toContain("surround");
    expect(contrastRatio(MUTED_INK, CHROME_SURFACES.readout)).toBeLessThan(READOUT_TEXT_CONTRAST);
    expect(contrastRatio(MUTED_INK, CHROME_SURFACES.surround)).toBeLessThan(BODY_TEXT_CONTRAST);
  });

  // The quiet end of the scale has three steps and they have to stay in
  // order: full ink, muted, disabled. A disabled label is exempt from §9's
  // floor, which is a reason to pick its value deliberately rather than a
  // reason to leave it composited and unmeasured.
  it("keeps the disabled ink readable, and quieter than the muted ink", () => {
    expect(MUTED_INK_SURFACES.length).toBeGreaterThan(0);
    for (const surface of MUTED_INK_SURFACES) {
      const face = CHROME_SURFACES[surface];
      expect(contrastRatio(DISABLED_INK, face)).toBeGreaterThanOrEqual(DISABLED_TEXT_CONTRAST);
      expect(contrastRatio(DISABLED_INK, face)).toBeLessThan(contrastRatio(MUTED_INK, face));
      expect(contrastRatio(MUTED_INK, face)).toBeLessThan(contrastRatio(INK, face));
    }
  });

  it("rejects the opacity that the disabled ink replaced", () => {
    // `.btn-secondary:disabled { opacity: 0.5 }` composited to this.
    expect(
      contrastRatio(composite(INK, CHROME_SURFACES.control, 0.5), CHROME_SURFACES.control),
    ).toBeLessThan(DISABLED_TEXT_CONTRAST);
  });

  it("rejects opacity as a way to quiet text — the failure that added this rule", () => {
    // 80% ink over the readout, composited the way a browser does it. This is
    // what shipped, and it is 5.37:1.
    expect(contrastRatio(composite(INK, CHROME_SURFACES.readout, 0.8), CHROME_SURFACES.readout))
      .toBeLessThan(READOUT_TEXT_CONTRAST);
    expect(contrastRatio(composite(INK, CHROME_SURFACES.panel, 0.8), CHROME_SURFACES.panel))
      .toBeLessThan(BODY_TEXT_CONTRAST);
  });
});

/** `alpha` of `over` composited on `under`, per-channel, as a browser does it. */
function composite(over: string, under: string, alpha: number): string {
  const channel = (hex: string, index: number) =>
    Number.parseInt(hex.slice(1 + index * 2, 3 + index * 2), 16);
  const mixed = [0, 1, 2].map((i) =>
    Math.round(channel(over, i) * alpha + channel(under, i) * (1 - alpha)),
  );
  return `#${mixed.map((v) => v.toString(16).padStart(2, "0")).join("")}`;
}

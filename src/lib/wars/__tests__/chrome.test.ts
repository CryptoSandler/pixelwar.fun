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
  MUTED_INK_INVERSE_SURFACES,
  BODY_TEXT_CONTRAST,
  CHIP_OUTLINE,
  CHIP_SURFACES,
  DISABLED_FACE,
  DISABLED_INK,
  DISABLED_TEXT_CONTRAST,
  INK,
  INK_INVERSE,
  MUTED_INK,
  MUTED_INK_INVERSE,
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
  // Every surface a chip appears on, of either polarity — NOT just the ones
  // the design chose. I2 used to ask `CHROME_SURFACES`, which meant the rail
  // could draw all twenty-four tokens on a Batch A `zinc-950` shell with no
  // outline and no declared outline to be missing, and the suite stayed green
  // while `#000000` was invisible on screen. A token vanishing into a surface
  // nobody designed has vanished exactly as completely.
  const surfaces = Object.keys(CHIP_SURFACES) as (keyof typeof CHIP_SURFACES)[];

  it.each(surfaces)("gives the chip a visible edge on the %s surface", (surface) => {
    const distance = rgbDistance(CHIP_OUTLINE[surface], CHIP_SURFACES[surface]);
    expect(distance).toBeGreaterThanOrEqual(OUTLINE_SURFACE_DISTANCE);
  });

  it("covers the two tokens that would otherwise disappear", () => {
    // #FFFFFF vanishes on light chrome and #000000 on dark. Both are real
    // palette entries, so both cases are reachable by a real war.
    for (const token of ["#FFFFFF", "#000000"]) {
      expect(PALETTE).toContain(token);
      for (const surface of surfaces) {
        const fillHides = rgbDistance(token, CHIP_SURFACES[surface]) < OUTLINE_SURFACE_DISTANCE;
        const outlineSaves =
          rgbDistance(CHIP_OUTLINE[surface], CHIP_SURFACES[surface]) >= OUTLINE_SURFACE_DISTANCE;
        // Either the fill separates on its own, or the outline does. Never neither.
        expect(fillHides && !outlineSaves).toBe(false);
      }
    }
  });

  it("names an outline for every surface, so a new surface cannot be added silently", () => {
    expect(Object.keys(CHIP_OUTLINE).sort()).toEqual(surfaces.slice().sort());
  });

  it("draws chips only on surfaces the design chose", () => {
    // This used to assert that two surface lists were disjoint, because
    // `CHIP_SURFACES` spread a second list of dark faces the board screen had
    // picked before DESIGN.md existed. The board screen draws on chrome
    // surfaces now and that list is gone, so the property worth holding is
    // the stronger one it was standing in for: every surface a chip lands on
    // is a surface I1 and I4 already police.
    expect(Object.keys(CHIP_SURFACES).sort()).toEqual(Object.keys(CHROME_SURFACES).sort());
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

  // The other half of the same rule: the primary button's disabled state was
  // a `filter` over the accent, which hides its rendered colour exactly as
  // well as an `opacity` does. Both ends of that button are named now, so
  // both can be measured.
  it("carries the disabled button's label at AA, and no louder than the live one", () => {
    expect(contrastRatio(DISABLED_FACE, INK)).toBeGreaterThanOrEqual(AA_NORMAL_TEXT);
    expect(contrastRatio(DISABLED_FACE, INK)).toBeLessThanOrEqual(contrastRatio(ACCENT, INK));
  });

  it("keeps the disabled button from reading as the accent, or as a token", () => {
    // I5's worry, applied to the only other large filled control there is:
    // quieter than the accent, and achromatic, so the biggest block of colour
    // on the screen after the board cannot be mistaken for a token's.
    expect(chroma(DISABLED_FACE)).toBeLessThan(chroma(ACCENT));
    expect(chroma(DISABLED_FACE)).toBeLessThan(0.1);
  });

  it("rejects the filter that the disabled face replaced", () => {
    // `filter: grayscale(0.7) brightness(0.9)` over ACCENT and INK, computed
    // through the CSS sRGB matrices: #8C846C carrying #202023.
    expect(contrastRatio("#8C846C", "#202023")).toBeLessThan(AA_NORMAL_TEXT);
  });

  it("rejects the opacity that the disabled ink replaced", () => {
    // `.btn-secondary:disabled { opacity: 0.5 }` composited to this.
    expect(
      contrastRatio(composite(INK, CHROME_SURFACES.control, 0.5), CHROME_SURFACES.control),
    ).toBeLessThan(DISABLED_TEXT_CONTRAST);
  });

  // The quiet step exists twice, once per polarity. `MUTED_INK` is a dark ink
  // for light faces and reads 1.89:1 on the board's own chrome — not a quieter
  // colour, an invisible one — so a dark surface needs its own, and it is
  // measured exactly the way the light one is.
  it("carries body text at the floor on every dark face declared for it", () => {
    expect(MUTED_INK_INVERSE_SURFACES.length).toBeGreaterThan(0);
    for (const name of MUTED_INK_INVERSE_SURFACES) {
      const face = CHROME_SURFACES[name];
      expect(contrastRatio(MUTED_INK_INVERSE, face), `${name} (${face})`).toBeGreaterThanOrEqual(
        BODY_TEXT_CONTRAST,
      );
    }
  });

  it("keeps the board ground off that list, because it does not clear the floor", () => {
    // The omission is the invariant, not an oversight. MUTED_INK_INVERSE
    // reads 6.54:1 on the board ground — under §9's body floor — so the
    // board carries full ink or nothing, exactly as the readout and the
    // surround do on the light side. The restyle's first draft put the
    // canvas's loading line here in muted ink; this case is what a repeat
    // costs.
    expect(MUTED_INK_INVERSE_SURFACES).not.toContain("board");
    expect(contrastRatio(MUTED_INK_INVERSE, CHROME_SURFACES.board)).toBeLessThan(
      BODY_TEXT_CONTRAST,
    );
    // And the colour the board must use instead does clear it.
    expect(contrastRatio(INK_INVERSE, CHROME_SURFACES.board)).toBeGreaterThanOrEqual(
      BODY_TEXT_CONTRAST,
    );
  });

  // The scale, not the usage. `DISABLED_INK` is not drawn on a board surface
  // today — the board's one disabled control is the Paint button, whose label
  // carries the cooldown countdown and takes the muted colour because a
  // countdown is information rather than decoration on a dead key. The order
  // is asserted anyway, so that the day something genuinely out of reach
  // appears on a dark face there is already a measured step below muted for
  // it to use, instead of an `opacity` invented on the spot.
  it("keeps the dark scale in order: full ink, muted, disabled", () => {
    for (const name of MUTED_INK_INVERSE_SURFACES) {
      const face = CHROME_SURFACES[name];
      const full = contrastRatio(INK_INVERSE, face);
      const muted = contrastRatio(MUTED_INK_INVERSE, face);
      const dead = contrastRatio(DISABLED_INK, face);
      expect(muted, `${name} muted vs full`).toBeLessThan(full);
      expect(dead, `${name} disabled vs muted`).toBeLessThan(muted);
      expect(dead, `${name} disabled floor`).toBeGreaterThanOrEqual(DISABLED_TEXT_CONTRAST);
    }
  });

  it("proves the light muted ink could not have been used there instead", () => {
    // The control that makes the second colour a necessity rather than a
    // preference: if MUTED_INK ever clears the body floor on a dark face,
    // MUTED_INK_INVERSE is redundant and should go.
    for (const name of MUTED_INK_INVERSE_SURFACES) {
      const face = CHROME_SURFACES[name];
      expect(contrastRatio(MUTED_INK, face), `${name} (${face})`).toBeLessThan(BODY_TEXT_CONTRAST);
    }
  });

  it("records what the opacity the chrome replaced actually rendered", () => {
    // This case used to pin six figures, five of them measured against three
    // zinc faces the board screen had picked before DESIGN.md existed. Those
    // faces are gone — the board screen draws on chrome surfaces now — and
    // the constant's own note said the record had to be re-measured rather
    // than quietly re-derived when they moved. Re-measuring a composite over
    // a surface that no longer exists would be recording fiction, so what
    // survives is the one figure whose surface is still on screen.
    const rendered = (over: string, base: string, alpha: number) =>
      contrastRatio(composite(over, base, alpha), base);

    // page.tsx — the only one of the six that inherited the chrome rather
    // than Tailwind, and the only one whose figure the batch that found it
    // had right. Still 3.85:1, still under the body floor, still the reason
    // quiet text is a colour here and never an alpha.
    expect(rendered(INK, CHROME_SURFACES.surround, 0.7)).toBeCloseTo(3.85, 2);
    expect(rendered(INK, CHROME_SURFACES.surround, 0.7)).toBeLessThan(BODY_TEXT_CONTRAST);
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

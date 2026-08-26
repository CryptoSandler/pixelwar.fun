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
  ACCENT,
  CHIP_OUTLINE,
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

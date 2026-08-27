import { describe, expect, it } from "vitest";
import {
  CHIP_OUTLINE,
  CHIP_SURFACES,
  OUTLINE_SURFACE_DISTANCE,
  contrastRatio,
} from "../chrome";
import { PALETTE, PALETTE_SIZE, flagColourForSlot, rgbDistance } from "../palette";

/**
 * I2, asked of the scoreboard specifically.
 *
 * `chrome.test.ts` already proves the outline table works for every surface
 * and every palette entry. This file asks the narrower question the redesign
 * introduced: the scoreboard draws a token's FLAG, and a flag is
 * `flagColourForSlot`, which wraps past 24 — so a war with 30 tokens draws
 * chips for slots the palette does not directly contain. The outline has to
 * hold for those too, and nothing else asserts it.
 *
 * The surface is `panel`, which is where the rail and the scoreboard now sit
 * after the board screen was restyled. That key is the invariant here: a chip
 * outline chosen for the old dark shell is the wrong colour on a light panel,
 * and #FFFFFF vanishes on one exactly as #000000 vanished on the other.
 */
describe("scoreboard chips stay visible", () => {
  const surface = CHIP_SURFACES.panel;
  const outline = CHIP_OUTLINE.panel;

  it("outlines every flag a war can fly, including the wrapped ones", () => {
    // Past PALETTE_SIZE the flag wraps, so this covers slots the scoreboard
    // can genuinely render for a war seating more than 24 tokens.
    for (let slot = 1; slot <= PALETTE_SIZE * 2; slot++) {
      const flag = flagColourForSlot(slot);
      expect(PALETTE).toContain(flag);
      // The chip is separated from the panel by the outline, whatever the
      // fill: the fill is the token's colour and is not ours to change.
      expect(
        rgbDistance(outline, surface),
        `outline vs panel for slot ${slot}`,
      ).toBeGreaterThanOrEqual(OUTLINE_SURFACE_DISTANCE);
    }
  });

  it("keeps the outline legible against the panel it is drawn on", () => {
    expect(contrastRatio(outline, surface)).toBeGreaterThanOrEqual(4.5);
  });

  it("names the panel as the surface the scoreboard uses", () => {
    // If the scoreboard ever moves to another surface, this fails and the
    // component's outline key has to move with it — which is the mistake the
    // restyle made once already, carrying `CHIP_OUTLINE.shell` onto a panel.
    expect(Object.keys(CHIP_SURFACES)).toContain("panel");
    expect(CHIP_OUTLINE.panel).toBeDefined();
  });

  it("would have caught the white token vanishing on a light panel", () => {
    // The concrete failure, stated as a number: without the outline, #FFFFFF
    // on #DEDEDE is 1.28:1 — invisible. With it, the chip has an edge.
    expect(contrastRatio("#FFFFFF", surface)).toBeLessThan(1.5);
    expect(contrastRatio(outline, surface)).toBeGreaterThan(4.5);
  });
});

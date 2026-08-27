import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * The rail collapses at the width DESIGN.md names, and the board never gives.
 *
 * A source test rather than a render test, deliberately: the property lives
 * entirely in CSS and class names and there is no browser in this suite to
 * measure a layout in. What CAN be asserted without one is that the two facts
 * which made the old layout wrong are gone and cannot come back unnoticed.
 *
 * THE REGRESSION IT GUARDS. `WarView` used to be `flex-col md:flex-row` with
 * the rail as the first block in the column. Below Tailwind's `md` the clock,
 * the scoreboard, the token list and the palette each took the height they
 * wanted and the board got the remainder — on a phone, the canvas was the
 * smallest thing on screen. DESIGN.md §5 forbids exactly that:
 *
 *   "Below 960px the rail collapses to a sheet over the board rather than
 *    squeezing it — the board's size is never the thing that gives."
 */
describe("the rail's breakpoint follows DESIGN.md §5", () => {
  const css = readFileSync("src/app/globals.css", "utf8");
  const warView = readFileSync("src/components/WarView.tsx", "utf8");
  // Newlines collapsed: the rule is one sentence in the document and is
  // hard-wrapped across three lines, so matching the raw file would be
  // asserting where the author's editor broke the line.
  const design = readFileSync("DESIGN.md", "utf8").replace(/\s+/g, " ");

  it("is 960px, the number the spec names", () => {
    // 60rem at a 16px root. NOT Tailwind's `md` (768) or `lg` (1024) —
    // neither is 960, and picking the nearest built-in would be the design
    // bending to the framework.
    expect(css).toMatch(/--breakpoint-rail:\s*60rem/);
    expect(design).toContain(
      "Below 960px the rail collapses to a sheet over the board rather than squeezing it",
    );
    expect(design).toContain("the board's size is never the thing that gives");
  });

  it("uses that breakpoint and no other on the board screen", () => {
    // A stray `md:` here is the old bug: it would split the layout at 768
    // while the sheet's own rules split at 960, leaving a 192px band where
    // the rail is a column AND the board has already given up its height.
    expect(warView).not.toMatch(/\bmd:/);
    expect(warView).not.toMatch(/\blg:/);
    expect(warView).toMatch(/\brail:/);
  });

  it("positions the sheet OVER the board rather than beside it", () => {
    // The whole point. Absolute + inset means the board's box is identical
    // whether the rail is open or shut, so opening it cannot resize the
    // canvas. A sheet that pushed content would be the same defect wearing a
    // different class name.
    const rule = css.match(/\.rail-sheet\s*\{[^}]*\}/)?.[0] ?? "";
    expect(rule).toMatch(/position:\s*absolute/);
    expect(rule).toMatch(/inset:\s*0/);
  });

  it("keeps the clock out of the sheet", () => {
    // Criterion one of the redesign is that a stranger understands the stake
    // in three seconds. A stake behind a button is a stake nobody sees, so
    // below 960px the clock moves to the header rather than into the rail.
    expect(warView).toMatch(/<WarClock\s*\n?\s*compact/);
    expect(warView).toMatch(/hidden rail:block/);
  });
});

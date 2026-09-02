import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * The chrome budget, and the mechanisms that keep the board above it.
 *
 * WHAT THIS CAN AND CANNOT DO, SAID PLAINLY. The budget in DESIGN.md §5 is a
 * set of measured percentages, and a percentage needs a browser at a viewport
 * to produce. `scripts/board-share.mjs` is that measurement; it is NOT run
 * here, because Playwright is not a dependency of this project and
 * `~/.claude/GATES.md` treats a Playwright run as a machine-wide exclusive
 * resource — putting one inside `npm test` would make every unrelated suite on
 * this machine contend for it.
 *
 * So this guards the two things that can be checked without a browser, and
 * they are the two that actually decide the number:
 *
 *   1. the budget is still written down, with all four viewports;
 *   2. the LAYOUT MECHANISMS that produce it are still in the source.
 *
 * The mechanisms are the point. Each one below was measured, and each has a
 * number attached in the document. A change that quietly removes one does not
 * fail because a percentage moved — it fails here, at the line that removed
 * it, which is where somebody can still see why it mattered.
 */

const design = readFileSync("DESIGN.md", "utf8");
const collapsed = design.replace(/\s+/g, " ");

/**
 * The component with its comments stripped.
 *
 * NOT FUSSINESS — the first version of this file matched bare strings against
 * the whole component and TWO of its three falsifications passed. `absolute`
 * and `pointer-events-none` were satisfied by the prose in the comment
 * explaining them, and by an unrelated full-frame overlay; `rail:flex-row` was
 * satisfied by the main row container 240 lines away. A guard that a comment
 * can satisfy is a guard that survives the deletion of the thing it guards.
 */
const warView = readFileSync("src/components/WarView.tsx", "utf8")
  .replace(/\/\*[\s\S]*?\*\//g, "")
  .replace(/\{\/\*[\s\S]*?\*\/\}/g, "");

/**
 * Whether the status element is a DESCENDANT of `.board-frame`.
 *
 * Walks div depth from the frame's opening tag. If the depth returns to zero
 * before the status element is reached, the frame closed first and the element
 * is a sibling — which is exactly the layout that reflowed the board.
 */
function isInsideBoardFrame(source: string): boolean {
  const start = source.indexOf('className="board-frame');
  const target = source.indexOf('role="status"');
  if (start === -1 || target === -1 || target < start) return false;

  let depth = 1; // the frame's own <div ... className="board-frame">
  const region = source.slice(start, target);
  for (const tag of region.matchAll(/<div\b|<\/div>/g)) {
    depth += tag[0] === "</div>" ? -1 : 1;
    if (depth <= 0) return false;
  }
  return depth > 0;
}

/** The className of the one element matching `attr`, so assertions bind to it. */
function classNameOf(source: string, attr: string): string {
  const at = source.indexOf(attr);
  if (at === -1) return "";
  // Search both directions: className may precede or follow the marker attr.
  const window = source.slice(Math.max(0, at - 400), at + 400);
  const matches = [...window.matchAll(/className=\{?[`"]([^`"]*)[`"]/g)].map((m) => m[1]);
  return matches.join(" | ");
}

describe("the chrome budget is recorded", () => {
  it("names every viewport and its floor", () => {
    // Control: the section really was found, so "no match" below cannot be a
    // failed read reporting itself as a clean bill of health.
    expect(design).toContain("### The chrome budget, measured");

    for (const [viewport, floor] of [
      ["390×844", "65.9%"],
      ["1440×900", "61.3%"],
      ["1920×1080", "68.6%"],
      ["2560×1440", "75.9%"],
    ]) {
      expect(collapsed).toContain(viewport);
      expect(collapsed).toContain(floor);
    }

    // The tightest viewport is named as such, because a budget with no worst
    // case is a budget nobody knows where to watch.
    expect(collapsed).toContain("1440×900 is the tightest");
  });

  it("keeps the measurement re-derivable", () => {
    // A recorded number with no way to reproduce it is folklore. The script is
    // committed and named in the document.
    expect(collapsed).toContain("scripts/board-share.mjs");
    const script = readFileSync("scripts/board-share.mjs", "utf8");
    expect(script).toContain("board-share.test.ts");
    // It has to visit all four, or the table it produces is not the table
    // above.
    for (const w of ["390", "1440", "1920", "2560"]) expect(script).toContain(w);
  });
});

describe("the board cannot be reflowed by chrome", () => {
  /**
   * THE DEFECT THIS EXISTS FOR. DESIGN.md §5 has always said "the board never
   * reflows" and "the board's size is never the thing that gives". Measured
   * 2026-09-02, a status line appearing took 43px of board height at 1440×900
   * and 44px at 390×844 — and the message that appears most often is the
   * cooldown refusal, the commonest answer this application gives.
   */
  it("renders the status line as an overlay inside the board frame", () => {
    // Control: this is the file that draws the board, and it has exactly one
    // status element to bind to.
    expect(warView).toContain("board-frame");
    expect(warView.match(/role="status"/g)).toHaveLength(1);

    // INSIDE the frame, checked by CONTAINMENT rather than by position in the
    // file. An earlier version sliced from the frame down to the paint bar and
    // called that "inside", so moving the status line out of the frame but
    // above the paint bar still passed — the falsification that mattered most
    // was the one it could not see.
    expect(isInsideBoardFrame(warView)).toBe(true);

    // And the classes are read off THAT element, not found anywhere in the
    // file. This is what the first version of this test got wrong.
    const statusClasses = classNameOf(warView, 'role="status"');
    expect(statusClasses).toContain("absolute");
    // It must never eat a click meant for a pixel underneath it.
    expect(statusClasses).toContain("pointer-events-none");
  });

  it("does not reserve height for the status line instead", () => {
    // Reserving was tried and measured WORSE — it cost a phone 4.8% of the
    // screen permanently, 65.9% down to 61.1%, to prevent a shift that only
    // sometimes happened. The document records that so it is not retried.
    expect(collapsed).toContain("Reserving its height was tried first and was worse");
    expect(collapsed).toContain("61.1%");
  });

  it("lays the paint bar as a row where there is width to spare", () => {
    // This is the board GAINING the height the chrome frees, and it is why the
    // desktop figures rise while the phone's stays put. `rail:` is the 960px
    // breakpoint §5 already defines; a second breakpoint here would be a
    // second number to keep in step.
    // Bound to the paint bar itself. `rail:flex-row` also sits on the main
    // row container, which is why matching the bare string proved nothing.
    const paintBar = warView.slice(warView.indexOf("shrink-0 flex-col gap-2"));
    expect(paintBar.slice(0, 120)).toContain("rail:flex-row");
    expect(collapsed).toContain("the paint bar is a ROW, not a column");
  });
});

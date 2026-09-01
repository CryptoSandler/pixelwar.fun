import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * Stacking charges stay rejected, and the documents stay agreed about it.
 *
 * WHAT THIS IS GUARDING AGAINST, AND IT ALREADY HAPPENED ONCE.
 * `docs/references.md` spent a batch saying both things at the same time: its
 * "Don't adopt" table rejected wplace's stacking charges, and its attribution
 * table listed a charge pool as a mechanic of this round with N and T still to
 * be chosen. Nobody lied — the second table was written by somebody reading
 * the research and not the rejection, which is exactly how a long document
 * comes apart.
 *
 * WHY IT IS WORTH A TEST RATHER THAN A NOTE. The rejection's stated reason is
 * that stacking lets a group "bank a burst and flip a region at the deadline",
 * and that is the same threat the last window was built against: a paint holds
 * a row lock on `wars` for five round trips, so a burst does not degrade, it
 * QUEUES. A charge pool re-entering as an adopted mechanic would be an
 * accelerator shipped one batch after the brake, and it would arrive as a
 * plausible table row rather than as an argument anybody had.
 *
 * WHY IT IS STRUCTURAL AND NOT A GREP. Both documents legitimately contain the
 * word. `references.md` describes wplace's charges as research and rejects
 * them by name; `DESIGN.md` says "cover charge", "charges a click" and "free
 * of charge", none of which are this mechanic. A test that banned the string
 * would fail on the first read and be deleted within a week. So this asks the
 * narrow question instead: does the word appear where an ADOPTED mechanic
 * would live?
 */

const references = readFileSync("docs/references.md", "utf8");
const design = readFileSync("DESIGN.md", "utf8");

/** The rows of the table under a given `###`/`##` heading, markdown pipes and all. */
function tableRowsUnder(markdown: string, heading: string): string[] {
  const start = markdown.indexOf(heading);
  if (start === -1) return [];
  // Up to the next heading of any level, so a table cannot leak into the next
  // section's rows and quietly widen what this test looks at.
  const rest = markdown.slice(start + heading.length);
  const end = rest.search(/\n#{2,3} /);
  return (end === -1 ? rest : rest.slice(0, end))
    .split("\n")
    .filter((line) => line.trimStart().startsWith("|") && !/^\s*\|[\s|:-]+\|\s*$/.test(line));
}

describe("the charge pool stays rejected", () => {
  it("is not listed as a mechanic this project adopted", () => {
    const adopted = tableRowsUnder(references, "## Provenance of the mechanics round");

    // THE CONTROL. Every assertion below is "no row matches", and "no row
    // matches" is also what a table this function failed to find looks like.
    // These two rows are in that table today, so if the parse breaks, this
    // fails first and says so — instead of the suite reporting a clean bill of
    // health for a table nobody read.
    expect(adopted.length).toBeGreaterThan(3);
    expect(adopted.join("\n")).toContain("Empty-board roster");
    expect(adopted.join("\n")).toContain("In-page replay from history");

    const readopted = adopted.filter((row) => /charge/i.test(row));
    expect(readopted).toEqual([]);
  });

  it("is still in the Don't adopt table, with the reason that decided it", () => {
    const rejected = tableRowsUnder(references, "### Don't adopt").join("\n");

    expect(rejected).toContain("Charges that stack");
    // The reason is load-bearing and not decoration: it is the same threat the
    // last window was built against, and a row that kept the verdict but lost
    // the argument is a row somebody overturns in a year with no idea what it
    // cost. Same discipline as the canvas cache's ceiling comment.
    expect(rejected.replace(/\s+/g, " ")).toContain(
      "bank a burst and flip a region at the deadline",
    );
  });

  it("keeps the decision written down where the contradiction was", () => {
    expect(references).toContain("### The charge pool was considered and rejected");
    expect(references.replace(/\s+/g, " ")).toContain(
      "There is no charge pool, and stacking charges are not a mechanic this product has.",
    );
  });

  /**
   * DESIGN.md is the document that describes what this product IS, so the
   * mechanic appearing there at all is adoption — there is no research section
   * for it to be quoted in.
   *
   * Matched on the phrases that can only mean the mechanic. A bare /charge/
   * would hit "cover charge", "charges a click" and the MIT licence's "free of
   * charge", all of which are in the file right now.
   */
  it("has not appeared in DESIGN.md under any of its names", () => {
    // Control first: the file really was read, and it really does contain the
    // innocent uses this test is careful to allow.
    expect(design).toContain("free of charge");

    for (const name of [
      /charge pool/i,
      /paint charges/i,
      /charges that stack/i,
      /stack(ing|able) charges/i,
      /charges instead of a cooldown/i,
    ]) {
      expect(design).not.toMatch(name);
    }
  });
});

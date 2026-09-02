import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * The documents still describe the payment path that exists.
 *
 * WHY THIS TEST EXISTS AT ALL, AND IT IS NOT TIDINESS. On 2026-08-31 the USDC
 * checkout was deleted — `verifyPayment`, the SPL transfer builder, the mint
 * constants, their tests — and admission moved to SOL. `docs/operations.md`
 * recorded it. The README and the design spec did not, and stayed wrong for a
 * batch: the README described "a one-off USDC entry" and the spec, which the
 * README links as *Design* and which is therefore the first document anybody
 * reads, still specified the mint to check, the token account to create and
 * the `transferChecked` to build.
 *
 * Nothing failed. Nothing could have — a stale sentence in a Markdown file is
 * invisible to `tsc`, to ESLint, to `next build` and to every other test here.
 * It is only visible to the next person, and by then they have built against
 * it. CLAUDE.md's rule that a verdict is made against the document OPEN
 * carries an explicit second edge — *a citation can be stale* — and this is
 * the mechanical half of that: the code moved, so the documents have to fail
 * when they disagree.
 *
 * WHAT IT DOES NOT DO. It does not police prose. It asserts three things that
 * are facts about the codebase rather than opinions about wording: SOL is
 * named as the denomination, USDC is not presented as a live path, and the
 * date the change happened is written down where somebody can follow it.
 *
 * Matched on collapsed whitespace, per CLAUDE.md: these sentences are
 * hard-wrapped and asserting the raw file would assert where an editor broke
 * the line.
 */

const flat = (path: string) => readFileSync(path, "utf8").replace(/\s+/g, " ");

const README = "README.md";
const SPEC = "docs/superpowers/specs/2026-08-24-pixelwar-design.md";
const OPERATIONS = "docs/operations.md";

describe("the README describes the charges that exist", () => {
  it("names SOL for both of them", () => {
    const readme = flat(README);
    // THE CONTROL. `toContain` against a file read from the wrong path fails
    // exactly like a sentence that was deleted. The wordmark is unmissable,
    // so a broken read and a broken claim are two different failures.
    expect(readme).toContain("# pixelwar.fun");

    expect(readme).toContain("one-off SOL admission");
    expect(readme).toContain("one wallet, one small SOL transfer");
  });

  it("does not sell a USDC entry", () => {
    expect(flat(README)).not.toMatch(/one-off USDC|entry in USDC|paying.{0,20}in USDC/i);
  });

  it("says painting takes a registration, not that it is free", () => {
    // DESIGN.md §1a: painting has required a paid registration since
    // 2026-08-26, and "free" is additionally a ONE-WAY PROMISE this product
    // has deliberately never made in published copy.
    const readme = flat(README);
    expect(readme).toContain("Painting takes a one-time registration");
    expect(readme).not.toMatch(/painting is free/i);
  });

  it("points at the deletion rather than pretending it never happened", () => {
    const readme = flat(README);
    expect(readme).toContain("2026-08-31");
    expect(readme).toContain("DECISIONES.md");
  });
});

describe("the spec was corrected in place rather than left or deleted", () => {
  it("carries a dated correction at the top", () => {
    const spec = flat(SPEC);
    expect(spec).toContain("# pixelwar.fun — design"); // the control
    expect(spec).toContain("Corrected in place:** 2026-09-02");
    expect(spec).toContain("Admission and painter registration are both charged in SOL");
  });

  it("keeps every remaining mention of USDC marked as superseded or as bidoor's", () => {
    /*
     * THE ASSERTION THAT MATTERS, and it is deliberately not "the word USDC
     * does not appear". Some of them have to: the correction itself says what
     * the document used to claim, and the separation from bidoor IS a fact
     * about USDC — a bidoor bid is an SPL transfer that moves no native
     * lamports, which is the only thing keeping two products apart on one
     * receiving wallet.
     *
     * So this walks every line that still says USDC and requires each one to
     * be marked. A NEW, unmarked USDC sentence — somebody reintroducing the
     * old path in prose — is what fails here.
     */
    /*
     * BY PARAGRAPH, NOT BY LINE, and the first version of this test was by
     * line and failed on its own document. Every sentence in these files is
     * hard-wrapped, so the word "USDC" routinely lands on a different physical
     * line from the marker that qualifies it. A line-granular check asserts
     * where an editor broke the text, which is the mistake CLAUDE.md names
     * about matching raw files.
     */
    const paragraphs = readFileSync(SPEC, "utf8")
      .split(/\n\s*\n/)
      .filter((block) => block.includes("USDC"));

    expect(paragraphs.length).toBeGreaterThan(0); // control: the read found the file

    /*
     * WHAT COUNTS AS MARKED. Either the paragraph says the claim is historical
     * — corrected, superseded, deleted, dated to the removal — or it is about
     * BIDOOR, where USDC is a live and load-bearing fact rather than a stale
     * one. A paragraph that says USDC and none of these is a new, unqualified
     * claim, which is exactly the thing this test is here to stop coming back.
     */
    const MARKED = /corrected|correction|this said|stopped being true|superseded|deleted|2026-08-31|bidoor/i;

    for (const block of paragraphs) {
      expect(MARKED.test(block), `unmarked USDC claim:\n${block.trim()}`).toBe(true);
    }
  });

  it("no longer tells a reader to build an SPL transfer", () => {
    const spec = flat(SPEC);
    expect(spec).toContain("native `SystemProgram.transfer`");
    expect(spec).not.toContain("The client builds a USDC transfer");
  });

  it("names what is still stale rather than leaving it to be discovered", () => {
    // The palette, the cap and the board size are all out of date in this
    // document too, and correcting them was not this batch's scope. Naming
    // them is the difference between a known gap and a trap.
    const spec = flat(SPEC);
    expect(spec).toContain("What is still stale in this document");
    expect(spec).toContain("The palette is free");
    expect(spec).toContain("Board size is per war");
  });
});

describe("operations.md is still the document the other two defer to", () => {
  it("carries the denomination rule the corrections cite", () => {
    const operations = flat(OPERATIONS);
    expect(operations).toContain("# Operating rules"); // the control
    expect(operations).toContain("Pixelwar charges in SOL, on every surface");
    expect(operations).toContain("Since 2026-08-31 there is no USDC anywhere in this product");
  });
});

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { sidesLockMinutes } from "../../lib/config";

/**
 * A rule that can refuse a painter has to be on the screen before it refuses.
 *
 * WHAT THIS PROTECTS, AND WHY A TEST IN ANOTHER FILE IS NOT ENOUGH. The last
 * window ships as a mechanism with its policy switched off:
 * `PAINT_SIDES_LOCK_MINUTES` is 0 everywhere, and turning it up is only
 * allowed together with the "Sides lock in mm:ss" countdown in `WarClock`, in
 * the same batch. Nothing in the code can see the value of an environment
 * variable in a deployment, so that condition lives in two documents — and a
 * condition living only in a document is one delete away from never having
 * existed. This asserts the sentences are still there, the same way
 * `canvas-cache.test.ts` asserts its route still explains its own number.
 *
 * MATCHED ON COLLAPSED WHITESPACE, per CLAUDE.md: both sentences are
 * hard-wrapped, and asserting the raw file would be asserting where somebody's
 * editor broke the line. A test that fails on a reflow is a test people learn
 * to edit rather than read.
 */

const design = readFileSync("DESIGN.md", "utf8").replace(/\s+/g, " ");
const operations = readFileSync("docs/operations.md", "utf8").replace(/\s+/g, " ");

describe("the announcement rule is still written down", () => {
  it("is in DESIGN.md, in the copy section", () => {
    // THE CONTROL. Every other assertion here is a `toContain` against a
    // string, and a `toContain` against a file that failed to read the way
    // the author expected fails identically to a rule that was deleted. This
    // one names the section the rule has to live in, so "the rule is gone"
    // and "the rule moved out of §8" and "the read is broken" are three
    // different failures instead of one.
    expect(design).toContain("## 8. Copy");

    expect(design).toContain("A refusal the screen never announced is a defect");
    expect(design).toContain("Sides lock in mm:ss");
    expect(design).toContain("WarClock.tsx");
    expect(design).toContain("Never a 409 without an announcement.");
  });

  it("is in docs/operations.md, as a condition on the setting", () => {
    expect(operations).toContain("PAINT_SIDES_LOCK_MINUTES");
    expect(operations).toContain("TURNING THIS ON REQUIRES THE COUNTDOWN, IN THE SAME BATCH");
    expect(operations).toContain("Never a 409 without an announcement.");
  });

  /**
   * The half of the rule that IS mechanical, and it is the one that would
   * bite hardest.
   *
   * Every deployment reads this function, so changing the fallback from 0 to
   * anything else switches the lock on everywhere at once — with no
   * countdown, no announcement, and no environment variable to point at
   * afterwards. That is precisely the failure the two documents describe, and
   * unlike the rest of the rule it can be caught here rather than by a
   * reviewer.
   */
  it("cannot be switched on by changing a default", () => {
    const before = process.env.PAINT_SIDES_LOCK_MINUTES;
    try {
      delete process.env.PAINT_SIDES_LOCK_MINUTES;
      expect(sidesLockMinutes()).toBe(0);

      // Garbage must fail towards "the rule is not in force". A typo in an
      // environment must never enable a rule about what winning means.
      process.env.PAINT_SIDES_LOCK_MINUTES = "sixty";
      expect(sidesLockMinutes()).toBe(0);

      // Negative is not "a lock in the past", it is a typo.
      process.env.PAINT_SIDES_LOCK_MINUTES = "-30";
      expect(sidesLockMinutes()).toBe(0);

      // And a real value still works, or the three assertions above would
      // pass against a function that always returns 0.
      process.env.PAINT_SIDES_LOCK_MINUTES = "60";
      expect(sidesLockMinutes()).toBe(60);
    } finally {
      if (before === undefined) delete process.env.PAINT_SIDES_LOCK_MINUTES;
      else process.env.PAINT_SIDES_LOCK_MINUTES = before;
    }
  });
});

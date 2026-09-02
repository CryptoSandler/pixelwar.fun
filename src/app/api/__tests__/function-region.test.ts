import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * The functions stay in the database's region.
 *
 * WHY THIS IS WORTH A TEST AND THE OTHER DEPLOY SETTINGS ARE NOT. Every paint
 * holds a row lock on `wars` for five more round trips before COMMIT, so the
 * per-war write ceiling is `1 / (5 × round-trip time)` and the round trip is
 * almost entirely network. Measured on production 2026-09-01: 15-16 ms with
 * the functions in `iad1` and the Neon project in `us-east-2`, about 2 ms once
 * they were in the same region. That is the difference between a ceiling near
 * 12 paints per second and one near a hundred.
 *
 * AND THE REGRESSION IS SILENT. Deleting the `regions` pin does not fail a
 * deploy, does not raise an error and does not change a single line of
 * application code — the functions simply fall back to the default region and
 * every paint gets six times slower under the lock. Nothing else in this
 * repository would notice. `docs/operations.md` said as much in prose; this is
 * that sentence made false.
 *
 * IT ASSERTS THE PAIRING, NOT THE STRING `cle1`. The rule is not "cle1
 * forever" — it is "the functions are wherever the database is". If the Neon
 * project moves, this test should be updated in the same batch as the pin, and
 * the constant below is the one place to do it.
 */

/** The AWS region the Neon project lives in, and the Vercel region that matches it. */
const NEON_REGION = "aws-us-east-2";
const MATCHING_VERCEL_REGION = "cle1";

describe("function region", () => {
  it("is pinned, and pinned to the database's region", () => {
    const config = JSON.parse(readFileSync("vercel.json", "utf8")) as {
      regions?: string[];
      crons?: unknown[];
    };

    // Control: the file really was read and parsed as the config, not as an
    // empty object that would satisfy every assertion below by absence.
    expect(config.crons).toBeDefined();

    expect(config.regions).toEqual([MATCHING_VERCEL_REGION]);
  });

  it("keeps the reason beside the number", () => {
    // The pin is three words in a JSON file and means nothing on its own. A
    // reader who finds it without the measurement deletes it as clutter, which
    // is exactly the silent regression. Same discipline as the canvas cache's
    // ceiling: the assertion and the argument travel together or neither is
    // worth much.
    const operations = readFileSync("docs/operations.md", "utf8").replace(/\s+/g, " ");

    expect(operations).toContain(MATCHING_VERCEL_REGION);
    expect(operations).toContain("KEEP THE TWO TOGETHER IF EITHER MOVES.");
    expect(operations).toContain(
      "silently restores a 16 ms hop and a ceiling six times lower",
    );
    // The region the pin has to match, named in the document rather than only
    // in this file.
    expect(operations.toLowerCase()).toContain("us-east-2");
    expect(NEON_REGION).toContain("us-east-2");
  });
});

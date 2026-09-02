import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * There is no replay, and `pixel_events` is not a publishable artifact.
 *
 * WHY THIS IS GUARDED RATHER THAN JUST DECIDED. `revertRegion` clears the
 * board by `DELETE`ing from `pixels` and APPENDING clearing events; it never
 * deletes the originals. So `pixel_events` still holds every pixel a moderator
 * took down, and anything that renders that log renders them again. The spec
 * listed replay as deferred work "which `pixel_events` already supports" —
 * true when written, false once `revertRegion` existed. Somebody reading only
 * the spec would have built it in good faith.
 *
 * WHY IT IS STRUCTURAL AND NOT A GREP FOR "replay". The word is load-bearing
 * elsewhere in this repository and always has been: `oath.ts` and
 * `registration.ts` are full of signature-replay defences, and
 * `cron/reconcile/route.ts` says Vercel Cron "does not follow redirects or
 * replay from cache". A test that banned the string would fail on its first
 * run against correct code. And DESIGN.md and the spec both QUOTE the stale
 * sentence in the course of correcting it, so even the documents cannot be
 * checked by absence alone.
 *
 * So this asks three narrow questions instead: has a replay ROUTE appeared,
 * has a replay COMPONENT appeared, and is replay still listed as deferred work
 * in the spec's own list.
 */

/**
 * Shipped files only. `__tests__` is skipped because this very file is called
 * `no-replay.test.ts` and matched its own guard on the first run — a test
 * named after the thing it forbids is not the thing it forbids, and the guard
 * is about what reaches a browser.
 */
function filesUnder(dir: string): string[] {
  const out: string[] = [];
  const walk = (d: string) => {
    for (const entry of readdirSync(d)) {
      if (entry === "__tests__") continue;
      const full = join(d, entry);
      if (statSync(full).isDirectory()) walk(full);
      else out.push(full);
    }
  };
  walk(dir);
  return out;
}

/**
 * Matched against PATHS, where a plain substring is right and a word boundary
 * is wrong. The first version required a non-letter on both sides, which meant
 * `ReplayPlayer.tsx` did not match: under the `i` flag `[^a-z]` excludes
 * uppercase too, so the `P` of `Player` failed the trailing class. It passed
 * the falsification that added a route and failed the one that added a
 * component, which is how it was found.
 *
 * A path is safe to match loosely precisely because the file SYSTEM does not
 * talk about signature replay — that word lives in prose inside `oath.ts` and
 * `registration.ts`, never in a filename. `__tests__` is excluded above.
 */
const REPLAY_SURFACE = /replay|timelapse|scrubber/i;

const design = readFileSync("DESIGN.md", "utf8");
const operations = readFileSync("docs/operations.md", "utf8");
const spec = readFileSync("docs/superpowers/specs/2026-08-24-pixelwar-design.md", "utf8");

describe("no replay surface exists", () => {
  it("has no replay route", () => {
    const routes = filesUnder("src/app/api");

    // THE CONTROL. Every assertion here is "nothing matches", which is also
    // what a walk of the wrong directory returns. These routes exist today,
    // so a broken walk fails here and says so rather than reporting a clean
    // bill of health for a tree nobody read.
    expect(routes.length).toBeGreaterThan(20);
    expect(routes.some((f) => f.includes(join("api", "diff")))).toBe(true);
    expect(routes.some((f) => f.includes(join("api", "canvas")))).toBe(true);

    expect(routes.filter((f) => REPLAY_SURFACE.test(f))).toEqual([]);
  });

  it("has no replay player component", () => {
    const components = filesUnder("src/components");

    expect(components.length).toBeGreaterThan(10);
    expect(components.some((f) => f.endsWith("WarClock.tsx"))).toBe(true);

    expect(components.filter((f) => REPLAY_SURFACE.test(f))).toEqual([]);
  });
});

describe("the decision stays written down", () => {
  it("is in DESIGN.md §5a, with the reason that decided it", () => {
    expect(design).toContain("### There is no replay, and it may never be built from `pixel_events`");
    // The reason is the load-bearing half. A rule that keeps its verdict and
    // loses its argument is one somebody overturns in a year with no idea what
    // it cost.
    expect(design.replace(/\s+/g, " ")).toContain(
      "It `DELETE`s from `pixels` — the current board — and then *appends* clearing events",
    );
  });

  it("is in docs/operations.md, and binds exports and not just a UI", () => {
    expect(operations).toContain("## No replay is served, and `pixel_events` is not a publishable artifact");
    expect(operations.replace(/\s+/g, " ")).toContain(
      "The rule is about the data leaving, not about the component.",
    );
  });

  /**
   * "Zero moderation clears" is recorded as the only honest exception anybody
   * has found. It is deliberately NOT a rule, and this asserts it stays that
   * way: adopting it would promise that a war with one clear never gets a
   * replay, and nobody has made that promise.
   */
  it("records the zero-moderation exception without adopting it", () => {
    const collapsed = design.replace(/\s+/g, " ");
    expect(collapsed).toContain("The only honest way out that anybody has found is recorded, NOT adopted.");
    expect(collapsed).toContain("it is **not** a rule, it is not a promise, and nothing is gated on it today");
  });
});

describe("the spec no longer authorises what it used to", () => {
  it("does not list replay as deferred work any more", () => {
    const start = spec.indexOf("## 17. Deferred");
    expect(start).toBeGreaterThan(-1);
    const section = spec.slice(start).split("## 18.")[0];

    // The list is the part BEFORE the correction note. Checking the whole
    // section would fail on the correction itself, which quotes the sentence
    // it is retracting — the same reason this file cannot grep for "replay".
    const list = section.split("**CORRECTED 2026-09-01")[0];

    // Control: this really is the deferred list and it really was read.
    expect(list).toContain("EVM chains and entry by burn");
    expect(list).toContain("alliances between tokens");

    expect(list).not.toMatch(/timelapse/i);
    expect(list).not.toMatch(/replay/i);
    expect(list).not.toContain("already");
  });

  it("carries the correction, dated, where the line used to be", () => {
    expect(spec).toContain("**CORRECTED 2026-09-01");
    expect(spec.replace(/\s+/g, " ")).toContain(
      "That was true when this was written and is false now, and the difference matters.",
    );
  });
});

describe("the retention decision is recorded with a price", () => {
  it("names an owner, a number, and the blocker that makes it a decision", () => {
    const collapsed = operations.replace(/\s+/g, " ");
    expect(operations).toContain("## `pixel_events` has no retention, and this is the pending decision");
    expect(collapsed).toContain("The reconcile sweep, `/api/cron/reconcile`");
    expect(collapsed).toContain("30 days after `ended_at`");
    // The blocker is what separates a pending decision from an unstarted task.
    expect(collapsed).toContain("`reviveWar` accepts any ended war, with no horizon, forever.");
    expect(collapsed).toContain("branch_logical_size_limit` on this project is 512 MB");
  });

  it("still describes a state where nothing prunes the table", () => {
    // If somebody implements the prune, this test should fail and be rewritten
    // along with the section — a document that describes an unowned table
    // while a job quietly owns it is worse than either.
    const source = readFileSync("src/app/api/cron/reconcile/route.ts", "utf8");
    expect(source).toContain("pruneOathNonces");
    expect(source).toContain("pruneTokenSnapshots");
    expect(source).not.toMatch(/prunePixelEvents/);
  });
});

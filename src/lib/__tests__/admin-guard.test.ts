/**
 * The refusal floor.
 *
 * These use fake timers rather than measuring real wall time. A timing test
 * that sleeps and then asserts on the clock is the flakiest thing you can put
 * in a suite — and flaky here means green on broken code, which is the one
 * outcome a security test must never produce. With fake timers the assertion is
 * exact: the promise has not settled at floor − 1ms and has settled at floor.
 *
 * No database, so no per-test timeout is needed.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { holdRefusal, REFUSAL_FLOOR_MS } from "../admin-guard";

/** Has `promise` settled by now? Never resolves to a value the caller waits on. */
function settled(promise: Promise<unknown>): Promise<boolean> {
  return Promise.race([
    promise.then(() => true),
    Promise.resolve().then(() => false),
  ]);
}

describe("the refusal floor", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("holds a refusal that arrived instantly until the floor", async () => {
    const startedAtMs = Date.now();
    const pending = holdRefusal(startedAtMs);

    await vi.advanceTimersByTimeAsync(REFUSAL_FLOOR_MS - 1);
    expect(await settled(pending)).toBe(false);

    await vi.advanceTimersByTimeAsync(1);
    expect(await settled(pending)).toBe(true);
  });

  it("holds a refusal that already took some time for only the remainder", async () => {
    // The configured path spends four database round trips before refusing.
    // It must end up at the same place on the clock as the path that spent
    // none — that is the whole point.
    const startedAtMs = Date.now();
    await vi.advanceTimersByTimeAsync(REFUSAL_FLOOR_MS - 10);

    const pending = holdRefusal(startedAtMs);
    await vi.advanceTimersByTimeAsync(9);
    expect(await settled(pending)).toBe(false);

    await vi.advanceTimersByTimeAsync(1);
    expect(await settled(pending)).toBe(true);
  });

  it("does not pad a refusal that already exceeded the floor", async () => {
    // A floor, not a constant. Padding a slow path to floor + elapsed would
    // give every refusal the variance the floor exists to hide.
    const startedAtMs = Date.now();
    await vi.advanceTimersByTimeAsync(REFUSAL_FLOOR_MS * 3);

    const pending = holdRefusal(startedAtMs);
    await vi.advanceTimersByTimeAsync(0);
    expect(await settled(pending)).toBe(true);
  });

  it("returns the same refusal every path returns", async () => {
    const pending = holdRefusal(Date.now());
    await vi.advanceTimersByTimeAsync(REFUSAL_FLOOR_MS);
    const response = await pending;

    expect(response.status).toBe(401);
    expect(response.headers.get("cache-control")).toBe("no-store");
    await expect(response.json()).resolves.toEqual({ error: "Not authorised." });
  });

  it("keeps the floor above four database round trips", () => {
    // The gap being closed is four Neon round trips. If someone lowers this
    // below the work it is hiding, the floor stops hiding anything and this
    // test is the only thing that would say so.
    expect(REFUSAL_FLOOR_MS).toBeGreaterThanOrEqual(200);
  });
});

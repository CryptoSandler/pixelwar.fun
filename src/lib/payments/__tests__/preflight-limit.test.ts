import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import { execute, query } from "../../db";
import { preflightLimits, preflightRateLimited, recordVerificationAttempt } from "../settle";

/**
 * The pre-flight's limiter, and the retry it must never refuse.
 *
 * THE CASE THIS FILE IS ABOUT: somebody is told they need more SOL, they fund
 * the wallet in another tab, and they come back within a few seconds. That is
 * the check working exactly as designed — it sent them away so they could fix
 * it — and the verifier's own limiter would have refused them, because it
 * carries a three-second floor between attempts and a cap tuned for a
 * different question ("stop somebody spending RPC quota against one order").
 */

const KEY = () => `preflight:${randomUUID()}`;

/** An attempt recorded as having happened `secondsAgo` seconds ago. */
async function attemptAt(key: string, ipHash: string | null, secondsAgo: number) {
  await execute(
    `INSERT INTO verification_attempts (id, order_id, ip_hash, attempted_at)
     VALUES ($1, $2, $3, now() - ($4 || ' seconds')::interval)`,
    [randomUUID(), key, ipHash, String(secondsAgo)],
  );
}

beforeEach(() => {
  delete process.env.PREFLIGHT_RATE_LIMIT_MAX;
});

describe("the natural retry gets through", () => {
  it("lets a second check ten seconds after the first one pass", async () => {
    // The headline case. Ten seconds is faster than anybody funds a wallet,
    // and it still must not be refused.
    const key = KEY();
    await attemptAt(key, "ip-retry", 10);

    expect(await preflightRateLimited(key, "ip-retry")).toEqual({ limited: false });
  });

  it("lets a check one second after the first one pass, too", async () => {
    // There is deliberately NO minimum gap. A double-click, a re-render, an
    // impatient person — none of those is the abuse this limit is for, and
    // the verifier's three-second floor would have refused all three.
    const key = KEY();
    await attemptAt(key, "ip-fast", 1);

    expect(await preflightRateLimited(key, "ip-fast")).toEqual({ limited: false });
  });

  it("still allows the fifth check in a minute, and refuses the sixth", async () => {
    const key = KEY();
    for (let i = 0; i < 4; i++) await attemptAt(key, "ip-five", i * 5);
    expect(await preflightRateLimited(key, "ip-five")).toEqual({ limited: false });

    await attemptAt(key, "ip-five", 1);
    const sixth = await preflightRateLimited(key, "ip-five");
    expect(sixth.limited).toBe(true);
    if (!sixth.limited) throw new Error("unreachable");
    // A sentence, not a code. Nothing about quotas or windows.
    expect(sixth.message).toContain("Wait a moment");
  });

  it("forgets an attempt older than the window", async () => {
    // A minute, so somebody who hit the limit while funding is not locked out
    // for the ten minutes the verifier's window would have held them.
    const key = KEY();
    for (let i = 0; i < 6; i++) await attemptAt(key, "ip-old", 90 + i);

    expect(await preflightRateLimited(key, "ip-old")).toEqual({ limited: false });
  });

  it("counts per wallet, so one payer's retries do not refuse another's", async () => {
    const busy = KEY();
    for (let i = 0; i < 6; i++) await attemptAt(busy, "ip-shared", i);
    expect((await preflightRateLimited(busy, "ip-shared")).limited).toBe(true);

    // Same address, different wallet: still fine, because the per-address
    // ceiling is separate and higher — one host may carry several people.
    expect(await preflightRateLimited(KEY(), "ip-shared")).toEqual({ limited: false });
  });

  it("still stops one address hammering with many wallets", async () => {
    // The ceiling that protects the RPC quota rather than any one wallet.
    const { perIp } = preflightLimits();
    for (let i = 0; i < perIp; i++) await attemptAt(KEY(), "ip-flood", i % 60);

    expect((await preflightRateLimited(KEY(), "ip-flood")).limited).toBe(true);
  });

  it("writes its attempts where it reads them", async () => {
    // The wiring: a limiter that counts a table nothing writes is a limiter
    // that never fires. `recordVerificationAttempt` is what the route calls.
    const key = KEY();
    await recordVerificationAttempt(key, "ip-wiring");

    const rows = await query(`SELECT 1 FROM verification_attempts WHERE order_id = $1`, [key]);
    expect(rows.length).toBe(1);
  });
});

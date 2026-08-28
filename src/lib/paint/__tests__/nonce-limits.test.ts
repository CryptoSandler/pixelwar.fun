import { beforeEach, describe, expect, it } from "vitest";
import { execute, query } from "../../db";
import { makeWar } from "../../canvas/__tests__/fixtures";
import { issueOathChallenge, pruneOathNonces, tooManyNonces } from "../oath";
import { issueLinkChallenge } from "../registration";

/**
 * Audit findings A-2 and A-3: issuing a challenge writes a row, so it needs a
 * limit and the rows need an end.
 *
 * Both surfaces write into `oath_nonces`, so one limit over that table is the
 * honest shape — two allowances would just be one allowance spent twice.
 */

beforeEach(() => {
  delete process.env.NONCE_RATE_LIMIT_MAX;
  delete process.env.NONCE_RATE_LIMIT_WINDOW_MINUTES;
});

describe("issuing challenges is bounded", () => {
  it("counts a caller's challenges across BOTH surfaces", { timeout: 20_000 }, async () => {
    process.env.NONCE_RATE_LIMIT_MAX = "3";
    const war = await makeWar();

    expect(await tooManyNonces("ip-mixed")).toBe(false);
    await issueOathChallenge({ warId: war.id, warSlug: war.slug, ticker: "T1", ipHash: "ip-mixed" });
    await issueLinkChallenge("ip-mixed");
    expect(await tooManyNonces("ip-mixed")).toBe(false);

    // The third crosses the line, and it does not matter which surface issued
    // it: a caller who can spend one budget on oaths and another on links has
    // twice the allowance the number says.
    await issueLinkChallenge("ip-mixed");
    expect(await tooManyNonces("ip-mixed")).toBe(true);

    // Somebody else is unaffected — this is a per-caller limit, not a global
    // one, and a global one would be an outage anybody could cause.
    expect(await tooManyNonces("ip-someone-else")).toBe(false);
  });

  it("does not limit a caller with no address, because there is nothing to count", async () => {
    // Only reachable with ALLOW_UNTRUSTED_CLIENT_IP, which production refuses
    // to run with. Stated as behaviour rather than left to be discovered.
    process.env.NONCE_RATE_LIMIT_MAX = "1";
    await issueLinkChallenge(null);
    await issueLinkChallenge(null);
    expect(await tooManyNonces(null)).toBe(false);
  });

  it("falls back to a working default when the setting is junk", async () => {
    process.env.NONCE_RATE_LIMIT_MAX = "not-a-number";
    await issueLinkChallenge("ip-junk");
    // Twenty is the default; one row is nowhere near it. A malformed setting
    // that silently meant "zero" would refuse everybody.
    expect(await tooManyNonces("ip-junk")).toBe(false);
  });
});

describe("expired challenges are swept", () => {
  it("deletes what nobody can use, and keeps what is still live", async () => {
    // Migration 010 said this happened and nothing did it. The sweeper is
    // hung off the daily reconcile pass — see the cron route.
    await issueLinkChallenge("ip-sweep");
    await execute(
      `INSERT INTO oath_nonces (nonce, war_id, message, expires_at, issued_at)
       VALUES ('long-dead', NULL, 'm', now() - interval '3 days', now() - interval '4 days')`,
    );

    const swept = await pruneOathNonces();

    expect(swept).toBe(1);
    const left = await query<{ nonce: string }>(`SELECT nonce FROM oath_nonces`);
    expect(left.map((r) => r.nonce)).not.toContain("long-dead");
    expect(left.length).toBe(1);
  });

  it("keeps a nonce that expired within the day", async () => {
    // A grace day past expiry, deliberately: the verifier already refuses an
    // expired nonce on the clock, so the row costs nothing and leaves an
    // operator looking at a replay attempt something to look at.
    await execute(
      `INSERT INTO oath_nonces (nonce, war_id, message, expires_at, issued_at)
       VALUES ('recently-dead', NULL, 'm', now() - interval '1 hour', now() - interval '2 hours')`,
    );
    expect(await pruneOathNonces()).toBe(0);
  });
});

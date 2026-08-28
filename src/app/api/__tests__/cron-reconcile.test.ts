import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { execute, query } from "../../../lib/db";

/**
 * The guard on the reconcile trigger.
 *
 * `recoverUnclaimedOrders` is mocked out here on purpose: what these tests are
 * for is whether the route lets a caller reach it at all. The recovery pass
 * itself has its own suite (`lib/payments/__tests__/recover.test.ts`), it
 * makes RPC calls, and a test that ran it for real would be testing the
 * wrong thing — a guard that leaks is a guard that leaks whether or not the
 * work behind it succeeds.
 *
 * The guard tests touch no database and need no per-test timeout. The one
 * test below that does — the expire-before-recover wiring — carries its own
 * `{ timeout: 20_000 }`.
 */
const recover = vi.hoisted(() =>
  vi.fn<() => Promise<{ recovered: string[]; filed: string[] }>>(async () => ({
    recovered: [],
    filed: [],
  })),
);

vi.mock("../../../lib/payments/recover", () => ({ recoverUnclaimedOrders: recover }));

const { POST: reconcileRoute, GET: reconcileGet } = await import("../cron/reconcile/route");

const SECRET = "test-cron-secret-3f9c1a";

function post(headers: Record<string, string> = {}): Request {
  return new Request("https://pixelwar.fun/api/cron/reconcile", {
    method: "POST",
    headers,
  });
}

describe("POST /api/cron/reconcile", () => {
  const original = process.env.CRON_SECRET;

  beforeEach(() => {
    recover.mockClear();
    recover.mockResolvedValue({ recovered: [], filed: [] });
    process.env.CRON_SECRET = SECRET;
  });

  afterEach(() => {
    if (original === undefined) delete process.env.CRON_SECRET;
    else process.env.CRON_SECRET = original;
  });

  it("refuses a request with no secret", async () => {
    const response = await reconcileRoute(post());

    expect(response.status).toBe(401);
    expect(recover).not.toHaveBeenCalled();
  });

  it("refuses a request with the wrong secret", async () => {
    const response = await reconcileRoute(post({ "x-cron-secret": "not-the-secret" }));

    expect(response.status).toBe(401);
    expect(recover).not.toHaveBeenCalled();
  });

  it("refuses a secret that is a prefix of the real one", async () => {
    // The comparison hashes both sides, so length is not a shortcut past it.
    const response = await reconcileRoute(post({ "x-cron-secret": SECRET.slice(0, -1) }));

    expect(response.status).toBe(401);
    expect(recover).not.toHaveBeenCalled();
  });

  it("fails closed when CRON_SECRET is unset", async () => {
    delete process.env.CRON_SECRET;

    // Not just "the right secret is rejected" — with no secret configured
    // there IS no right secret, and the alternative reading of an unset guard
    // (run unguarded) would make this a public way to spend the RPC quota
    // every live checkout shares.
    const withHeader = await reconcileRoute(post({ "x-cron-secret": SECRET }));
    const withoutHeader = await reconcileRoute(post());

    expect(withHeader.status).toBe(503);
    expect(withoutHeader.status).toBe(503);
    expect(recover).not.toHaveBeenCalled();
  });

  it("refuses an empty secret, even when CRON_SECRET is only whitespace", async () => {
    process.env.CRON_SECRET = "   ";

    const response = await reconcileRoute(post({ "x-cron-secret": "" }));

    expect(response.status).toBe(503);
    expect(recover).not.toHaveBeenCalled();
  });

  it("runs the pass and reports counts, not order ids, for the right secret", async () => {
    recover.mockResolvedValue({ recovered: ["order-a", "order-b"], filed: ["order-c"] });

    const response = await reconcileRoute(post({ "x-cron-secret": SECRET }));
    const body = await response.text();

    expect(response.status).toBe(200);
    expect(recover).toHaveBeenCalledTimes(1);
    // Exhaustive, and it stays exhaustive because this body leaves the
    // deployment for a CI log that is retained for ninety days and is
    // world-readable on a public repository. A field appearing here that
    // nobody asserted is how an order id — the handle on somebody's payment
    // — ends up published. `toEqual` is what noticed the backlog counts
    // arriving; the counts are fine, and the next addition gets the same
    // scrutiny.
    expect(JSON.parse(body)).toEqual({
      recovered: 2,
      filed: 1,
      // Housekeeping the audit gave an owner: expired signature challenges
      // used to accumulate forever behind a migration comment claiming they
      // were swept. A count rather than silence, so a sweeper that stops
      // working is visible in the same log that watches everything else.
      noncesSwept: 0,
      backlog: { open: 0, oldestAgeHours: 0, stale: false },
      // Null because no war is live in this test. That it is PRESENT and null
      // rather than absent is the contract reconcile.yml checks with
      // `has("board")` — a missing key and a null one are different answers,
      // and the workflow must be able to tell "no war" from "the endpoint
      // stopped reporting".
      board: null,
    });
    // The response goes into a CI log. No order id may travel with it.
    expect(body).not.toContain("order-a");
    expect(body).not.toContain("order-c");
    // Nor the secret itself.
    expect(body).not.toContain(SECRET);
  });

  it("never puts the secret in the body of a refusal", async () => {
    const response = await reconcileRoute(post({ "x-cron-secret": "wrong" }));
    const body = await response.text();

    expect(body).not.toContain(SECRET);
  });

  it(
    "expires stale orders BEFORE recovering, so a quiet site still gets a candidate set",
    { timeout: 20_000 },
    async () => {
      // The failure this pins down is not "expiry never happens" — it is
      // "expiry happens somewhere else, on somebody else's schedule".
      // `recoverUnclaimedOrders` selects on `status = 'expired'`, and the two
      // lazy call sites in orders.ts only set that status when a visitor loads
      // the colour picker or opens an order. This is the no-visitor case: a
      // reservation whose window closed, and not one request to the site
      // since. Nothing but this route can have expired it.
      const warId = randomUUID();
      await execute(
        `INSERT INTO wars (id, slug, title, status, width, height, max_tokens,
                            entry_price_usd, cooldown_seconds, starts_at, ends_at)
         VALUES ($1, $1, 'Fixture war', 'live', 8, 8, 24, 25, 30, $2, $3)`,
        [warId, new Date(Date.now() - 3_600_000), new Date(Date.now() + 3_600_000)],
      );

      const tokenId = randomUUID();
      await execute(
        `INSERT INTO war_tokens
           (id, war_id, chain_id, contract, contract_key, colour_slot, status,
            name, ticker, metadata_fetched_at, reserved_at)
         VALUES ($1, $2, 'solana', $1, $1, 5, 'reserved', 'Fixture', 'FIX', now(), now())`,
        [tokenId, warId],
      );

      const orderId = randomUUID();
      await execute(
        `INSERT INTO entry_orders
           (id, war_id, war_token_id, amount_usd, payer_pubkey, reference_pubkey, status,
            created_at, expires_at)
         VALUES ($1, $2, $3, 25, NULL, $1, 'pending',
                 now() - interval '40 minutes', now() - interval '10 minutes')`,
        [orderId, warId, tokenId],
      );

      // Reading the row from inside the mock is what makes this an ORDERING
      // test rather than merely a "the call exists somewhere" test: it records
      // what the recovery pass itself could see at the moment it ran. Moving
      // the expiry call below the recovery call fails this exactly as deleting
      // it does.
      let statusSeenByRecovery: string | undefined;
      recover.mockImplementation(async () => {
        const [row] = await query<{ status: string }>(
          `SELECT status FROM entry_orders WHERE id = $1`,
          [orderId],
        );
        statusSeenByRecovery = row?.status;
        return { recovered: [], filed: [] };
      });

      const response = await reconcileRoute(post({ "x-cron-secret": SECRET }));

      expect(response.status).toBe(200);
      expect(recover).toHaveBeenCalledTimes(1);
      expect(statusSeenByRecovery).toBe("expired");

      // And the colour the dead reservation was sitting on is genuinely back.
      const [tokenRow] = await query<{ status: string; released_reason: string | null }>(
        `SELECT status, released_reason FROM war_tokens WHERE id = $1`,
        [tokenId],
      );
      expect(tokenRow.status).toBe("released");
      expect(tokenRow.released_reason).toBe("order_expired");
    },
  );
});

/**
 * Vercel Cron's half of the door.
 *
 * Neither the method nor the header is this project's choice: Vercel invokes
 * a cron path with GET, and the only credential it sends is `CRON_SECRET` as
 * `Authorization: Bearer <...>`, provisioned by the platform. These tests
 * pin that contract down, because getting it wrong fails in the quietest
 * possible way — a daily sweep that 401s forever while the dashboard happily
 * reports the cron job as executed.
 */
describe("GET /api/cron/reconcile (Vercel Cron)", () => {
  const original = process.env.CRON_SECRET;

  function get(headers: Record<string, string> = {}): Request {
    return new Request("https://pixelwar.fun/api/cron/reconcile", { method: "GET", headers });
  }

  beforeEach(() => {
    recover.mockClear();
    recover.mockResolvedValue({ recovered: [], filed: [] });
    process.env.CRON_SECRET = SECRET;
  });

  afterEach(() => {
    if (original === undefined) delete process.env.CRON_SECRET;
    else process.env.CRON_SECRET = original;
  });

  it("accepts the bearer token Vercel sends", async () => {
    const response = await reconcileGet(get({ authorization: `Bearer ${SECRET}` }));

    expect(response.status).toBe(200);
    expect(recover).toHaveBeenCalled();
  });

  it("refuses a bearer token that is not the secret", async () => {
    const response = await reconcileGet(get({ authorization: "Bearer not-the-secret" }));

    expect(response.status).toBe(401);
    expect(recover).not.toHaveBeenCalled();
  });

  it("refuses an Authorization header that is not a bearer token", async () => {
    const response = await reconcileGet(get({ authorization: SECRET }));

    expect(response.status).toBe(401);
    expect(recover).not.toHaveBeenCalled();
  });

  it("refuses a request with no credential at all", async () => {
    const response = await reconcileGet(get());

    expect(response.status).toBe(401);
    expect(recover).not.toHaveBeenCalled();
  });

  it("fails closed when the deployment has no secret", async () => {
    delete process.env.CRON_SECRET;

    const response = await reconcileGet(get({ authorization: "Bearer anything" }));

    expect(response.status).toBe(503);
    expect(recover).not.toHaveBeenCalled();
  });
});

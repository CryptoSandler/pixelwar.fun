import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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
 * No database, so no per-test timeout is needed here.
 */
const recover = vi.hoisted(() =>
  vi.fn<() => Promise<{ recovered: string[]; filed: string[] }>>(async () => ({
    recovered: [],
    filed: [],
  })),
);

vi.mock("../../../lib/payments/recover", () => ({ recoverUnclaimedOrders: recover }));

const { POST: reconcileRoute } = await import("../cron/reconcile/route");

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
    expect(JSON.parse(body)).toEqual({ recovered: 2, filed: 1 });
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
});

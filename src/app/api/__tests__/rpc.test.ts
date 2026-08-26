import { afterEach, describe, expect, it, vi } from "vitest";
import { POST as rpcRoute } from "../rpc/route";

/**
 * The proxy the wallet adapter talks to instead of a Solana node directly.
 *
 * None of these tests touch the database — `identify()` never reads it, and
 * neither does this route. Every test drives the handler directly against a
 * stubbed `fetch`, so the suite stays fast and each assertion is about this
 * route's own logic, not the network.
 */

// x-forwarded-for, not cf-connecting-ip — see routes.test.ts for why: with
// TRUSTED_PLATFORM_HEADER unset, clientIp() reads x-forwarded-for, which is
// the header that keeps two distinct IPs genuinely distinct in this suite.
function post(body: unknown, ip = "1.2.3.4", extraHeaders: Record<string, string> = {}): Request {
  return new Request("https://pixelwar.fun/api/rpc", {
    method: "POST",
    headers: { "x-forwarded-for": ip, "content-type": "application/json", ...extraHeaders },
    body: JSON.stringify(body),
  });
}

function whitelistedCall(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { jsonrpc: "2.0", id: 1, method: "getLatestBlockhash", params: [], ...overrides };
}

/** Stubs `fetch` and hands back the mock so a test can inspect how it was called. */
function stubFetch(handler: (url: string, init: RequestInit) => unknown) {
  const fetchMock = vi.fn(async (url: string, init: RequestInit) => {
    const result = handler(url, init);
    return {
      ok: true,
      status: 200,
      json: async () => result,
    } as unknown as Response;
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("POST /api/rpc", () => {
  it("forwards a whitelisted method", async () => {
    const fetchMock = stubFetch(() => ({ jsonrpc: "2.0", id: 1, result: "fake-blockhash" }));

    const response = await rpcRoute(post(whitelistedCall()));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ jsonrpc: "2.0", id: 1, result: "fake-blockhash" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("forwards a whitelisted batch", async () => {
    const fetchMock = stubFetch((_url, init) => {
      const sent = JSON.parse(init.body as string);
      expect(Array.isArray(sent)).toBe(true);
      return [
        { jsonrpc: "2.0", id: 1, result: "fake-blockhash" },
        { jsonrpc: "2.0", id: 2, result: { context: {}, value: null } },
      ];
    });

    const response = await rpcRoute(
      post([whitelistedCall({ id: 1 }), whitelistedCall({ id: 2, method: "getAccountInfo" })]),
    );

    expect(response.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("rejects a method that is not whitelisted, without forwarding it", async () => {
    const fetchMock = stubFetch(() => ({}));

    const response = await rpcRoute(post(whitelistedCall({ method: "getProgramAccounts" })));

    expect(response.status).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects a batch containing a non-whitelisted method", async () => {
    const fetchMock = stubFetch(() => ({}));

    const response = await rpcRoute(
      post([whitelistedCall({ id: 1 }), whitelistedCall({ id: 2, method: "anythingAtAll" })]),
    );

    expect(response.status).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects a malformed JSON body, without forwarding it", async () => {
    const fetchMock = stubFetch(() => ({}));

    const response = await rpcRoute(
      new Request("https://pixelwar.fun/api/rpc", {
        method: "POST",
        headers: { "x-forwarded-for": "1.2.3.4", "content-type": "application/json" },
        body: "{not json",
      }),
    );

    expect(response.status).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("caps the body size, without forwarding an oversized body", async () => {
    const fetchMock = stubFetch(() => ({}));

    const response = await rpcRoute(
      post(whitelistedCall({ params: ["x".repeat(50_000)] })),
    );

    expect(response.status).toBe(413);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rate limits by ip_hash and fails closed without an address", async () => {
    const fetchMock = stubFetch(() => ({ jsonrpc: "2.0", id: 1, result: "fake-blockhash" }));
    const previousMax = process.env.RPC_RATE_LIMIT_MAX;
    process.env.RPC_RATE_LIMIT_MAX = "1";

    try {
      const ip = "9.9.9.9";
      const first = await rpcRoute(post(whitelistedCall(), ip));
      expect(first.status).toBe(200);

      const second = await rpcRoute(post(whitelistedCall(), ip));
      expect(second.status).toBe(429);

      // Only the first, allowed call ever reached the upstream stub.
      expect(fetchMock).toHaveBeenCalledTimes(1);
    } finally {
      if (previousMax === undefined) delete process.env.RPC_RATE_LIMIT_MAX;
      else process.env.RPC_RATE_LIMIT_MAX = previousMax;
    }

    // Fails closed: with no trustworthy client address, identify() refuses
    // before the rate limiter or the whitelist is ever consulted.
    const previousAllow = process.env.ALLOW_UNTRUSTED_CLIENT_IP;
    delete process.env.ALLOW_UNTRUSTED_CLIENT_IP;
    try {
      const noAddress = await rpcRoute(
        new Request("https://pixelwar.fun/api/rpc", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(whitelistedCall()),
        }),
      );
      expect(noAddress.status).toBe(400);
    } finally {
      if (previousAllow === undefined) delete process.env.ALLOW_UNTRUSTED_CLIENT_IP;
      else process.env.ALLOW_UNTRUSTED_CLIENT_IP = previousAllow;
    }
  });

  it("never returns the upstream URL or key in an error", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error(
          "fetch failed: connect ECONNREFUSED to https://paid-provider.example/?api-key=super-secret-key",
        );
      }),
    );

    const response = await rpcRoute(post(whitelistedCall(), "5.5.5.5"));
    const text = await response.text();

    expect(response.status).toBe(502);
    expect(text).not.toContain("paid-provider.example");
    expect(text).not.toContain("super-secret-key");
    expect(text).not.toContain("api-key");
  });

  it("does not forward client headers upstream", async () => {
    let sentHeaders: Headers | undefined;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init: RequestInit) => {
        sentHeaders = new Headers(init.headers);
        return {
          ok: true,
          status: 200,
          json: async () => ({ jsonrpc: "2.0", id: 1, result: "fake-blockhash" }),
        } as unknown as Response;
      }),
    );

    const response = await rpcRoute(
      post(whitelistedCall(), "6.6.6.6", {
        cookie: "pw_painter=super-secret-session",
        authorization: "Bearer should-not-leave-this-server",
        "x-forwarded-for": "6.6.6.6, 7.7.7.7",
      }),
    );

    expect(response.status).toBe(200);
    expect(sentHeaders).toBeDefined();
    expect(sentHeaders!.get("cookie")).toBeNull();
    expect(sentHeaders!.get("authorization")).toBeNull();
    expect(sentHeaders!.get("x-forwarded-for")).toBeNull();
    expect(sentHeaders!.get("content-type")).toBe("application/json");
  });
});

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { makeToken, makeWar } from "../../../lib/canvas/__tests__/fixtures";
import { execute } from "../../../lib/db";
import { GET as coloursRoute } from "../colours/route";
import { GET as tokenRoute } from "../token/route";

/**
 * The two lookups the entry flow makes before it commits to anything: what
 * colours are left, and what a pasted address actually is.
 */

const HEADERS = { "x-forwarded-for": "9.9.9.9" };
const MINT = "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263";

function get(path: string, ip = "9.9.9.9"): Request {
  return new Request(`https://pixelwar.fun${path}`, {
    headers: { ...HEADERS, "x-forwarded-for": ip },
  });
}

describe("GET /api/colours", () => {
  it("offers every slot of a war nobody has entered", { timeout: 20_000 }, async () => {
    const war = await makeWar();
    const response = await coloursRoute(get(`/api/colours?war=${war.slug}`));
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");

    const body = await response.json();
    expect(body.free).toHaveLength(war.maxTokens);
    expect(body.free[0]).toBe(1);
  });

  it("leaves out a colour an active token holds", { timeout: 20_000 }, async () => {
    const war = await makeWar();
    await makeToken(war.id, 3);

    const body = await (await coloursRoute(get(`/api/colours?war=${war.slug}`))).json();
    expect(body.free).not.toContain(3);
    expect(body.free).toContain(2);
  });

  it("leaves out a colour a pending reservation holds, before any money moves", { timeout: 20_000 }, async () => {
    const war = await makeWar();
    const id = await makeToken(war.id, 7);
    await execute(`UPDATE war_tokens SET status = 'reserved' WHERE id = $1`, [id]);

    const body = await (await coloursRoute(get(`/api/colours?war=${war.slug}`))).json();
    expect(body.free).not.toContain(7);
  });

  it("gives a released colour back", { timeout: 20_000 }, async () => {
    const war = await makeWar();
    const id = await makeToken(war.id, 5);
    await execute(`UPDATE war_tokens SET status = 'released', released_at = now() WHERE id = $1`, [id]);

    const body = await (await coloursRoute(get(`/api/colours?war=${war.slug}`))).json();
    expect(body.free).toContain(5);
  });

  it("says which war it cannot find rather than answering with an empty list", { timeout: 20_000 }, async () => {
    const response = await coloursRoute(get("/api/colours?war=nothing-here"));
    expect(response.status).toBe(404);
    expect((await response.json()).error).toBe("No such war");
  });

  it("requires a war", { timeout: 20_000 }, async () => {
    expect((await coloursRoute(get("/api/colours"))).status).toBe(400);
  });
});

describe("GET /api/token", () => {
  const original = globalThis.fetch;

  beforeEach(() => {
    // The module caches by chain + address for a minute, so a fixture from
    // one test would otherwise be served to the next.
    delete (globalThis as { __dexCache?: unknown }).__dexCache;
  });

  afterEach(() => {
    globalThis.fetch = original;
  });

  function servePairs(pairs: unknown[]): void {
    globalThis.fetch = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => pairs,
    })) as unknown as typeof fetch;
  }

  const PAIR = {
    chainId: "solana",
    url: "https://dexscreener.com/solana/abc",
    baseToken: { address: MINT, name: "Bonk", symbol: "Bonk" },
    liquidity: { usd: 100_000 },
    info: { imageUrl: "https://cdn.dexscreener.com/tokens/bonk.png" },
  };

  it("answers with what the address resolves to, so a payer can check it", async () => {
    servePairs([PAIR]);
    const response = await tokenRoute(get(`/api/token?chain=solana&contract=${MINT}`));
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");

    const body = await response.json();
    expect(body.name).toBe("Bonk");
    expect(body.ticker).toBe("BONK");
    expect(body.contract).toBe(MINT);
    expect(body.logoUrl).toContain("dexscreener.com");
  });

  it("refuses a malformed address without spending a lookup on it", async () => {
    const spy = vi.fn();
    globalThis.fetch = spy as unknown as typeof fetch;

    const response = await tokenRoute(get("/api/token?chain=solana&contract=not-an-address"));
    expect(response.status).toBe(400);
    expect(spy).not.toHaveBeenCalled();
  });

  it("refuses a chain it does not support", async () => {
    const response = await tokenRoute(get(`/api/token?chain=dogecoin&contract=${MINT}`));
    expect(response.status).toBe(400);
  });

  it("reports a token no DEX has seen as not found", async () => {
    globalThis.fetch = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => [],
    })) as unknown as typeof fetch;

    const response = await tokenRoute(get(`/api/token?chain=solana&contract=${MINT}`));
    expect(response.status).toBe(404);
  });

  it("stops a caller sweeping addresses through us at DexScreener", async () => {
    servePairs([PAIR]);
    process.env.TOKEN_RATE_LIMIT_MAX = "2";
    try {
      const ip = "9.9.9.10";
      for (let i = 0; i < 2; i++) {
        expect((await tokenRoute(get(`/api/token?chain=solana&contract=${MINT}`, ip))).status).toBe(200);
      }
      const response = await tokenRoute(get(`/api/token?chain=solana&contract=${MINT}`, ip));
      expect(response.status).toBe(429);
    } finally {
      delete process.env.TOKEN_RATE_LIMIT_MAX;
    }
  });
});

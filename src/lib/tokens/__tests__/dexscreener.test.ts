import { beforeEach, describe, expect, it, vi } from "vitest";
import { resolveToken, type TokenFetch } from "../dexscreener";

const MINT = "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263";
const OTHER_MINT = "SomeOtherMint1111111111111111111111111111111";
const HYPE_ADDR = "0xdAC17F958D2ee523a2206206994597C13D831ec7";

type Pair = Record<string, unknown>;

function pair(overrides: Pair = {}): Pair {
  return {
    chainId: "solana",
    url: "https://dexscreener.com/solana/abc",
    baseToken: { address: MINT, name: "Bonk", symbol: "Bonk" },
    quoteToken: { address: "So11111111111111111111111111111111111111112", symbol: "SOL" },
    liquidity: { usd: 100_000 },
    info: { imageUrl: "https://cdn.dexscreener.com/cms/images/abc?width=800" },
    ...overrides,
  };
}

/** Fabricates a fetch: serves the chain-scoped endpoint first, then the wider fallback. No network involved. */
function serve(scoped: Pair[], wide: Pair[] = []): TokenFetch {
  return vi.fn(async (url: string) => ({
    ok: true,
    status: 200,
    json: async () => (url.includes("/tokens/v1/") ? scoped : { pairs: wide }),
  }));
}

// This module caches successes and "not found" results for a minute, keyed
// by chain + address. Tests reuse the same fixture addresses across many
// different fabricated responses, so the cache has to be cleared before
// each one or a later test would silently read an earlier test's answer.
beforeEach(() => {
  delete (globalThis as { __dexCache?: unknown }).__dexCache;
});

describe("resolving a token", () => {
  it("reads name, ticker and logo from the matching pair", async () => {
    const result = await resolveToken("solana", MINT, serve([pair()]));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.metadata.name).toBe("Bonk");
    expect(result.metadata.ticker).toBe("BONK");
    expect(result.metadata.logoUrl).toContain("cdn.dexscreener.com");
  });

  it("keeps the logo's query string, which the CDN needs for sizing", async () => {
    const result = await resolveToken("solana", MINT, serve([pair()]));
    expect(result.ok && result.metadata.logoUrl).toContain("?width=800");
  });
});

describe("the token must be the base token of the pair", () => {
  it("rejects a pair where our address is only the quote side", async () => {
    // Real DexScreener behaviour: query one token and the top pair can come
    // back with a stablecoin as base. Reading baseToken blindly would list
    // the wrong token's name and logo entirely.
    const wrong = pair({
      baseToken: { address: OTHER_MINT, name: "USDC", symbol: "USDC" },
      quoteToken: { address: MINT, symbol: "Bonk" },
    });
    const result = await resolveToken("solana", MINT, serve([wrong], [wrong]));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.kind).toBe("not_found");
  });

  it("falls back to the wider lookup when the scoped one is unusable", async () => {
    const wrong = pair({ baseToken: { address: OTHER_MINT, name: "USDC", symbol: "USDC" } });
    const result = await resolveToken("solana", MINT, serve([wrong], [pair()]));
    expect(result.ok && result.metadata.name).toBe("Bonk");
  });
});

describe("the token must be on the selected chain", () => {
  it("rejects a pair from a different chain", async () => {
    const wrongChain = pair({ chainId: "pulsechain" });
    const result = await resolveToken("solana", MINT, serve([wrongChain], [wrongChain]));
    expect(result.ok).toBe(false);
  });

  // Chain-id trap: DexScreener's id for Hyperliquid is "hyperevm", not
  // "hyperliquid". Getting this wrong makes every lookup on the chain
  // silently return nothing — no error, just an empty result.
  it("queries DexScreener with the chain's own id, 'hyperevm', not 'hyperliquid'", async () => {
    const fetchMock = serve([]);
    await resolveToken("hyperliquid", HYPE_ADDR, fetchMock);
    expect(vi.mocked(fetchMock).mock.calls[0][0]).toContain("/tokens/v1/hyperevm/");
  });

  // Same trap, the other listed case: BNB Chain is "bsc" on DexScreener.
  it("queries DexScreener with the chain's own id, 'bsc', not 'bnb'", async () => {
    const fetchMock = serve([]);
    await resolveToken("bnb", "0x0000000000000000000000000000000000000001", fetchMock);
    expect(vi.mocked(fetchMock).mock.calls[0][0]).toContain("/tokens/v1/bsc/");
  });
});

describe("an address no DEX has ever seen", () => {
  it("reports not_found rather than pretending the token exists", async () => {
    const result = await resolveToken("base", "0xdAC17F958D2ee523a2206206994597C13D831ec7", serve([], []));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.kind).toBe("not_found");
    expect(result.message).toMatch(/not found/i);
  });

  it("never invents an identity for a token with no name", async () => {
    const result = await resolveToken(
      "solana",
      MINT,
      serve([pair({ baseToken: { address: MINT, name: "", symbol: "" } })]),
    );
    expect(result.ok).toBe(false);
  });
});

describe("an unknown chain", () => {
  it("is rejected before any fetch happens", async () => {
    const fetchMock = serve([]);
    const result = await resolveToken("dogecoin", MINT, fetchMock);
    expect(result.ok).toBe(false);
    expect(vi.mocked(fetchMock)).not.toHaveBeenCalled();
  });
});

describe("images", () => {
  it("drops a logo hosted anywhere other than DexScreener's CDN", async () => {
    const result = await resolveToken(
      "solana",
      MINT,
      serve([pair({ info: { imageUrl: "https://tracker.example.com/pixel.png" } })]),
    );
    expect(result.ok && result.metadata.logoUrl).toBeUndefined();
  });

  it("keeps a logo on DexScreener's own CDN", async () => {
    const result = await resolveToken("solana", MINT, serve([pair()]));
    expect(result.ok && result.metadata.logoUrl).toBeDefined();
  });
});

describe("links", () => {
  it("strips tracking params and normalizes twitter.com to x.com", async () => {
    const result = await resolveToken(
      "solana",
      MINT,
      serve([
        pair({
          info: {
            websites: [{ url: "https://bonkcoin.com/?utm_source=dex" }],
            socials: [
              { type: "twitter", url: "https://twitter.com/bonk_inu?s=21" },
              { type: "telegram", url: "https://t.me/Official_Bonk_Inu" },
            ],
          },
        }),
      ]),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.metadata.links.website).toBe("https://bonkcoin.com/");
    expect(result.metadata.links.x).toBe("https://x.com/bonk_inu");
    expect(result.metadata.links.telegram).toBe("https://t.me/Official_Bonk_Inu");
  });

  it("drops a social that fails our own link rules rather than failing the lookup", async () => {
    const result = await resolveToken(
      "solana",
      MINT,
      serve([pair({ info: { socials: [{ type: "twitter", url: "https://bit.ly/whatever" }] } })]),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.metadata.links.x).toBeUndefined();
  });
});

describe("failure modes", () => {
  it("reports unavailable when the API cannot be reached", async () => {
    const failing: TokenFetch = vi.fn(async () => {
      throw new Error("network down");
    });
    const result = await resolveToken("solana", MINT, failing);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.kind).toBe("unavailable");
  });

  it("reports unavailable on a non-200 response", async () => {
    const failing: TokenFetch = vi.fn(async () => ({ ok: false, status: 500, json: async () => ({}) }));
    const result = await resolveToken("solana", MINT, failing);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.kind).toBe("unavailable");
  });

  it("does not cache a transient outage", async () => {
    const failing: TokenFetch = vi.fn(async () => {
      throw new Error("down");
    });
    await resolveToken("solana", MINT, failing);

    const retry = await resolveToken("solana", MINT, serve([pair()]));
    expect(retry.ok).toBe(true);
  });
});

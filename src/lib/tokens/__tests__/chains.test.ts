import { describe, expect, it } from "vitest";
import { CHAINS, dexscreenerTokenUrl, getChain, isChainId } from "../chains";

describe("CHAINS", () => {
  it("lists all eight chains", () => {
    expect(CHAINS).toHaveLength(8);
    expect(new Set(CHAINS.map((c) => c.id)).size).toBe(8);
  });

  // The whole point of these two: DexScreener's id for a chain is not always
  // its name. Getting one wrong makes every lookup on that chain silently
  // return nothing — no error, just an empty answer that reads as "token not
  // found".
  it("maps BNB Chain to DexScreener's 'bsc', not 'bnb'", () => {
    expect(getChain("bnb")?.dexscreenerId).toBe("bsc");
  });

  it("maps Hyperliquid to DexScreener's 'hyperevm', not 'hyperliquid'", () => {
    expect(getChain("hyperliquid")?.dexscreenerId).toBe("hyperevm");
  });

  it("keeps every other chain's DexScreener id equal to its own id", () => {
    for (const chain of CHAINS) {
      if (chain.id === "bnb" || chain.id === "hyperliquid") continue;
      expect(chain.dexscreenerId).toBe(chain.id);
    }
  });
});

describe("getChain / isChainId", () => {
  it("finds a known chain", () => {
    expect(getChain("solana")?.name).toBe("Solana");
  });

  it("returns undefined / false for an unknown chain", () => {
    expect(getChain("dogecoin")).toBeUndefined();
    expect(isChainId("dogecoin")).toBe(false);
  });

  it("narrows the type for a known chain id", () => {
    expect(isChainId("robinhood")).toBe(true);
  });
});

describe("dexscreenerTokenUrl", () => {
  it("builds the DexScreener page for a chain and address", () => {
    expect(dexscreenerTokenUrl("solana", "abc")).toBe("https://dexscreener.com/solana/abc");
  });

  it("uses the chain's DexScreener id, not the chain id itself", () => {
    expect(dexscreenerTokenUrl("bnb", "0xabc")).toBe("https://dexscreener.com/bsc/0xabc");
    expect(dexscreenerTokenUrl("hyperliquid", "0xabc")).toBe("https://dexscreener.com/hyperevm/0xabc");
  });

  it("returns null for an unknown chain", () => {
    expect(dexscreenerTokenUrl("dogecoin", "abc")).toBeNull();
  });

  it("encodes the address", () => {
    expect(dexscreenerTokenUrl("solana", "a b")).toBe("https://dexscreener.com/solana/a%20b");
  });
});

import { describe, expect, it } from "vitest";
import { checkAddress, shortenAddress, validateAddress } from "../addresses";
import { CHAINS } from "../chains";

const USDC_SOL = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const USDT_ETH = "0xdAC17F958D2ee523a2206206994597C13D831ec7";
const USDT_TRON = "TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t";
const TON_EQ = "EQCxE6mUtQJKFnGfaROTKOt1lZbDiiX1kCixRv7Nw2Id_sDs";
const TON_UQ = "UQCxE6mUtQJKFnGfaROTKOt1lZbDiiX1kCixRv7Nw2Id_p0p";

const EVM_SAMPLE = "0x0000000000000000000000000000000000000001";

/** One real, well-formed address per chain, keyed by chain id. */
const VALID_BY_CHAIN: Record<string, string> = {
  solana: USDC_SOL,
  bnb: EVM_SAMPLE,
  robinhood: EVM_SAMPLE,
  base: EVM_SAMPLE,
  ethereum: USDT_ETH,
  ton: TON_EQ,
  tron: USDT_TRON,
  hyperliquid: EVM_SAMPLE,
};

describe("validateAddress, per chain", () => {
  it("covers every chain in the registry", () => {
    expect(Object.keys(VALID_BY_CHAIN).sort()).toEqual(CHAINS.map((c) => c.id).sort());
  });

  it.each(CHAINS.map((c) => c.id))("accepts a well-formed address on %s", (chainId) => {
    const result = validateAddress(chainId, VALID_BY_CHAIN[chainId]);
    expect(result.ok).toBe(true);
  });

  it.each(CHAINS.map((c) => c.id))("rejects an obviously malformed address on %s", (chainId) => {
    expect(validateAddress(chainId, "not-an-address").ok).toBe(false);
  });

  it("rejects an unknown chain id rather than guessing a family", () => {
    const result = validateAddress("dogecoin", USDC_SOL);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toMatch(/unknown chain/i);
  });

  it("is what paymentWallet in payments/config.ts now calls for its Solana check", () => {
    // Not a real import cycle check — just documents the contract: family
    // "solana" round-trips a real mint the same way payments/config.ts needs.
    expect(validateAddress("solana", USDC_SOL)).toMatchObject({ ok: true, canonical: USDC_SOL });
  });
});

describe("checkAddress: solana", () => {
  it("accepts real mints", () => {
    expect(checkAddress("solana", USDC_SOL).ok).toBe(true);
  });

  it("rejects an EVM address submitted as Solana", () => {
    expect(checkAddress("solana", USDT_ETH).ok).toBe(false);
  });

  it("rejects a mint that does not decode to 32 bytes", () => {
    expect(checkAddress("solana", USDC_SOL.slice(0, -2)).ok).toBe(false);
    expect(checkAddress("solana", USDC_SOL + "aa").ok).toBe(false);
  });

  it("rejects empty input with a friendly message", () => {
    const result = checkAddress("solana", "   ");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toMatch(/enter a contract address/i);
  });
});

describe("checkAddress: evm", () => {
  it("accepts checksummed and lowercase forms", () => {
    expect(checkAddress("evm", USDT_ETH).ok).toBe(true);
    expect(checkAddress("evm", USDT_ETH.toLowerCase()).ok).toBe(true);
  });

  it("collapses casing into one canonical key", () => {
    const a = checkAddress("evm", USDT_ETH);
    const b = checkAddress("evm", USDT_ETH.toLowerCase());
    expect(a.ok && b.ok && a.canonical === b.canonical).toBe(true);
  });

  it("rejects a Solana mint submitted as EVM", () => {
    expect(checkAddress("evm", USDC_SOL).ok).toBe(false);
  });

  it("rejects a value missing the 0x prefix", () => {
    expect(checkAddress("evm", USDT_ETH.slice(2)).ok).toBe(false);
  });
});

describe("checkAddress: tron", () => {
  it("accepts a real contract", () => {
    expect(checkAddress("tron", USDT_TRON).ok).toBe(true);
  });

  it("rejects a short address", () => {
    expect(checkAddress("tron", USDT_TRON.slice(0, -1)).ok).toBe(false);
  });
});

describe("checkAddress: ton", () => {
  it("accepts user-friendly and raw forms", () => {
    expect(checkAddress("ton", TON_EQ).ok).toBe(true);
    expect(
      checkAddress("ton", "0:b113a994cd5025016719f691393928eb75959b0e28975902c51d0feccc3621d1").ok,
    ).toBe(true);
  });

  it("rejects a checksum typo", () => {
    expect(checkAddress("ton", TON_EQ.slice(0, -1) + "t").ok).toBe(false);
  });

  it("collapses bounceable and non-bounceable into one canonical entry", () => {
    const eq = checkAddress("ton", TON_EQ);
    const uq = checkAddress("ton", TON_UQ);
    expect(eq.ok && uq.ok && eq.canonical === uq.canonical).toBe(true);
  });
});

describe("shortenAddress", () => {
  it("elides the middle of a long address", () => {
    expect(shortenAddress(USDC_SOL)).toBe("EPjF…Dt1v");
  });

  it("leaves a short value alone", () => {
    expect(shortenAddress("abc")).toBe("abc");
  });
});

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

  // The raw form is workchain ':' exactly 64 hex characters (32 bytes). The
  // regex is anchored at both ends, so one character short or long must both
  // fail rather than being truncated/padded and accepted.
  it("rejects a raw address one hex character short (63)", () => {
    const short = "0:b113a994cd5025016719f691393928eb75959b0e28975902c51d0feccc3621d";
    expect(checkAddress("ton", short).ok).toBe(false);
  });

  it("rejects a raw address one hex character long (65)", () => {
    const long = "0:b113a994cd5025016719f691393928eb75959b0e28975902c51d0feccc3621d10";
    expect(checkAddress("ton", long).ok).toBe(false);
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

/**
 * Fix round 1, Finding 1 (Critical): `base58Decode` is O(n^2) — it walks the
 * growing byte accumulator once per input character — and neither
 * `checkSolana` nor `checkAddress`'s dispatcher used to reject an oversized
 * input before reaching it. A caller who wants an unclaimed CPU-second only
 * has to send one very long string.
 *
 * These tests are load-bearing on TIME, not just on the boolean result: an
 * assertion that merely checks `ok === false` would keep passing even if
 * someone reintroduced the quadratic path, as long as it eventually finished
 * — these tests would not, they use the suite's ordinary 5s default (no
 * `{ timeout: 20_000 }` override) and their own explicit wall-clock bound, so
 * a regression to quadratic behaviour fails loudly instead of just being
 * slow. 200,000 characters was measured by the reviewer at ~1s pre-fix for
 * Solana alone with the OLD, unbounded regex; this is comfortably past that.
 */
describe("length is rejected before any decoding runs", () => {
  const HUGE = 200_000;

  it("rejects an oversized Solana address quickly", () => {
    const huge = "A".repeat(HUGE); // valid base58 characters throughout
    const started = Date.now();
    const result = checkAddress("solana", huge);
    const elapsedMs = Date.now() - started;

    expect(result.ok).toBe(false);
    expect(elapsedMs).toBeLessThan(500);
  });

  it("rejects an oversized EVM address quickly", () => {
    const huge = "0x" + "0".repeat(HUGE);
    const started = Date.now();
    const result = checkAddress("evm", huge);
    const elapsedMs = Date.now() - started;

    expect(result.ok).toBe(false);
    expect(elapsedMs).toBeLessThan(500);
  });

  it("rejects an oversized TRON address quickly", () => {
    const huge = "T" + "A".repeat(HUGE);
    const started = Date.now();
    const result = checkAddress("tron", huge);
    const elapsedMs = Date.now() - started;

    expect(result.ok).toBe(false);
    expect(elapsedMs).toBeLessThan(500);
  });

  it("rejects an oversized TON address quickly", () => {
    const huge = "0:" + "0".repeat(HUGE);
    const started = Date.now();
    const result = checkAddress("ton", huge);
    const elapsedMs = Date.now() - started;

    expect(result.ok).toBe(false);
    expect(elapsedMs).toBeLessThan(500);
  });

  it("uses each family's ordinary shape reason, not a separate 'too long' message", () => {
    // Confirms the length gate answers with the SAME reason the family's own
    // checker gives for a malformed address of ordinary size, per the fix's
    // instruction: refuse with "the family's normal 'not a valid address'
    // answer".
    const solanaLong = checkAddress("solana", "A".repeat(HUGE));
    const solanaBadShape = checkAddress("solana", "0xnotsolana");
    expect(!solanaLong.ok && !solanaBadShape.ok && solanaLong.reason).toBe(
      "A Solana address decodes to 32 bytes (usually 32–44 characters).",
    );

    const evmLong = checkAddress("evm", "0x" + "0".repeat(HUGE));
    expect(!evmLong.ok && evmLong.reason).toBe(
      "An EVM address is 0x followed by exactly 40 hex characters.",
    );
  });

  it("still rejects a merely wrong-length address the same as before", () => {
    // The new gate must not swallow the ordinary "too short"/"too long by a
    // little" cases into some new blanket answer — those still go through
    // the family's own check unchanged.
    expect(checkAddress("solana", "short").ok).toBe(false);
    expect(checkAddress("evm", "0x1234").ok).toBe(false);
  });
});

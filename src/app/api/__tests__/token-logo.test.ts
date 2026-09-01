import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The logo proxy at the route, not at the function.
 *
 * `image-fetch.test.ts` proves the refusals and `logo-source.ts` picks the
 * source; neither says anything about whether a request ever reaches them,
 * how often, or what leaves the deployment when it does. That is what this
 * file is for.
 *
 * The source layer is mocked, because these tests are about the ROUTE — its
 * front-door validation, its cache, its ceiling on outbound fetches, and what
 * it puts on the wire. A test that reached arweave would be testing arweave.
 */

const LOGO = { bytes: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 0, 0, 0, 0, 0]), contentType: "image/png" };
const MINT = "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263";
const OTHER_MINT = "EKpQGSJtjMFqKZ9KQanSqYXRcF8fBopzLHYxdM65zcjm";

const fetchTokenLogo = vi.hoisted(() => vi.fn());
vi.mock("../../../lib/tokens/logo-source", () => ({ fetchTokenLogo }));

async function get(mint: string) {
  const { GET } = await import("../token-logo/[mint]/route");
  return GET(new Request(`https://pixelwar.fun/api/token-logo/${mint}`), {
    params: Promise.resolve({ mint }),
  });
}

beforeEach(() => {
  // The cache and the rate-limit window live on globalThis so a warm instance
  // keeps them. Tests get a fresh one or they read each other's state.
  delete (globalThis as { __logoStore?: unknown }).__logoStore;
  fetchTokenLogo.mockReset();
  fetchTokenLogo.mockResolvedValue({ ok: true, source: "metaplex", image: { ok: true, ...LOGO } });
});

afterEach(() => vi.restoreAllMocks());

describe("the front door", () => {
  it("serves a logo for a well-formed mint", async () => {
    // THE CONTROL. Every refusal below is only evidence if this passes.
    const response = await get(MINT);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("image/png");
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(new Uint8Array(LOGO.bytes));
  });

  const malformed = [
    ["empty", ""],
    ["far too short", "abc"],
    ["far too long", "D".repeat(80)],
    ["base58 with a zero in it", "0ezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263"],
    ["base58 with an I in it", "IezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263"],
    ["a path traversal", "../../etc/passwd"],
    ["a URL", "https://evil.example/logo.png"],
    ["a URL-shaped mint", "http://169.254.169.254/"],
  ];

  for (const [name, mint] of malformed) {
    it(`refuses ${name} without asking any upstream`, async () => {
      const response = await get(mint);
      expect(response.status).toBe(400);
      // THE HALF THAT MATTERS: a bad mint must not cost an RPC call. Shape is
      // checked before anything else happens.
      expect(fetchTokenLogo).not.toHaveBeenCalled();
    });
  }
});

describe("what leaves the deployment", () => {
  it("sends our sniffed type, never an upstream header", async () => {
    // The upstream said nothing; the type is the one the source layer
    // determined from the bytes. Verifying by magic bytes and then forwarding
    // somebody else's Content-Type would be measuring one thing and
    // publishing another.
    fetchTokenLogo.mockResolvedValue({
      ok: true,
      source: "jupiter",
      image: { ok: true, bytes: LOGO.bytes, contentType: "image/webp" },
    });
    const response = await get(MINT);
    expect(response.headers.get("content-type")).toBe("image/webp");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
  });

  it("names no upstream anywhere in the response", async () => {
    // The point of proxying is that nothing of the upstream reaches the
    // browser. A header saying which of the three answered would undo that
    // for anybody with a network tab open.
    const response = await get(MINT);
    const headers = JSON.stringify([...response.headers.entries()]);
    for (const leak of ["arweave", "jupiter", "metaplex", "dexscreener", "ipfs", "http"]) {
      expect(headers.toLowerCase()).not.toContain(leak);
    }
  });

  it("answers 404, not an error, when a token has no logo", async () => {
    // The designed outcome: the scoreboard falls back to the flag colour,
    // which is what it shows for every token in production today.
    fetchTokenLogo.mockResolvedValue({ ok: false, reason: "no_logo" });
    const response = await get(MINT);
    expect(response.status).toBe(404);
    expect(await response.arrayBuffer()).toEqual(new ArrayBuffer(0));
  });
});

describe("the cache", () => {
  it("asks the upstream once for repeated requests", async () => {
    await get(MINT);
    await get(MINT);
    await get(MINT);
    expect(fetchTokenLogo).toHaveBeenCalledTimes(1);
  });

  it("remembers that a token has NO logo, which is the common case", async () => {
    // Without this, the majority of tokens re-ask three upstreams — including
    // an RPC call — on every single render.
    fetchTokenLogo.mockResolvedValue({ ok: false, reason: "no_logo" });
    await get(MINT);
    await get(MINT);
    expect(fetchTokenLogo).toHaveBeenCalledTimes(1);
  });

  it("keeps tokens apart", async () => {
    await get(MINT);
    await get(OTHER_MINT);
    expect(fetchTokenLogo).toHaveBeenCalledTimes(2);
  });
});

describe("the ceiling on outbound fetches", () => {
  it("stops dialling strangers' hosts once the minute's budget is spent", async () => {
    fetchTokenLogo.mockResolvedValue({ ok: false, reason: "no_logo" });
    // Distinct mints, so nothing is answered from cache and every one is a
    // miss. Base58 excludes 0, I, O and l, so the alphabet here is chosen to
    // survive the route's own front-door check.
    const alphabet = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
    for (let i = 0; i < 200; i++) {
      const suffix = alphabet[i % alphabet.length] + alphabet[(i * 7) % alphabet.length];
      await get(`Dez${suffix}Z8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB2${alphabet[i % 9]}`);
    }
    // The exact number is a policy; that there IS one is the invariant.
    expect(fetchTokenLogo.mock.calls.length).toBeLessThanOrEqual(60);
    expect(fetchTokenLogo.mock.calls.length).toBeGreaterThan(0);
  });

  it("never refuses a cached hit, however busy the minute has been", async () => {
    // Rate-limiting served bytes would punish a busy war for being busy. The
    // ceiling is on MISSES, and a hit costs nothing upstream.
    await get(MINT);
    const store = (globalThis as { __logoStore?: { window: { count: number } } }).__logoStore!;
    store.window.count = 10_000;

    const response = await get(MINT);
    expect(response.status).toBe(200);
    expect(fetchTokenLogo).toHaveBeenCalledTimes(1);
  });
});

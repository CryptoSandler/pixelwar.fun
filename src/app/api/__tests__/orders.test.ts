import { randomBytes, randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { base58Encode } from "../../../lib/base58";
import { execute, query } from "../../../lib/db";
import { GET as getOrderRoute } from "../orders/[id]/route";
import { POST as ordersRoute } from "../orders/route";

/**
 * The endpoint a community actually hits: POST an order to buy a token onto
 * a war's canvas, and GET its status while paying.
 *
 * A real Solana wallet, so `paymentWallet()` (which every request here
 * depends on) has something valid to read. Not a secret: this is a public
 * mainnet address used the same way in `lib/payments/__tests__/config.test.ts`.
 */
const PAYMENT_WALLET = "7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU";

// x-forwarded-for, not cf-connecting-ip — see routes.test.ts for why: with
// TRUSTED_PLATFORM_HEADER unset, clientIp() reads x-forwarded-for, which is
// the header that keeps two distinct IPs genuinely distinct in this suite.
function post(path: string, body: unknown, ip = "1.2.3.4"): Request {
  return new Request(`https://pixelwar.fun${path}`, {
    method: "POST",
    headers: { "x-forwarded-for": ip, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

function get(path: string): Request {
  return new Request(`https://pixelwar.fun${path}`, {
    headers: { "x-forwarded-for": "1.2.3.4" },
  });
}

/** A well-formed, random Solana address — valid base58, decodes to 32 bytes. */
function randomSolanaAddress(): string {
  return base58Encode(new Uint8Array(randomBytes(32)));
}

async function makeWar(
  overrides: Partial<{
    maxTokens: number;
    status: string;
    startsAt: Date;
    endsAt: Date;
  }> = {},
): Promise<{ id: string; slug: string }> {
  const id = randomUUID();
  await execute(
    `INSERT INTO wars (id, slug, title, status, width, height, max_tokens,
                        entry_price_usd, entry_price_sol, cooldown_seconds, starts_at, ends_at)
     VALUES ($1, $1, 'Fixture war', $2, 8, 8, $3, 25, 25000000, 30, $4, $5)`,
    [
      id,
      overrides.status ?? "live",
      overrides.maxTokens ?? 24,
      overrides.startsAt ?? new Date(Date.now() - 3_600_000),
      overrides.endsAt ?? new Date(Date.now() + 3_600_000),
    ],
  );
  return { id, slug: id };
}

function orderBody(
  overrides: Partial<{ warSlug: string; chainId: string; contract: string; colourSlot: number; payerPubkey: string }> & {
    warSlug: string;
  },
): Record<string, unknown> {
  return {
    warSlug: overrides.warSlug,
    chainId: overrides.chainId ?? "solana",
    contract: overrides.contract ?? randomSolanaAddress(),
    colourSlot: overrides.colourSlot ?? 5,
    ...(overrides.payerPubkey !== undefined ? { payerPubkey: overrides.payerPubkey } : {}),
  };
}

/**
 * Stubs global `fetch` so `resolveToken`'s default fetch implementation (the
 * only one the route ever injects — it calls `resolveToken` with no
 * override, exactly as production does) never reaches the real network.
 *
 * Answers the chain-scoped endpoint with one pair whose base token IS the
 * requested address, for whatever address is asked about — enough for every
 * test here, none of which cares about DexScreener's own quirks (those are
 * `lib/tokens/__tests__/dexscreener.test.ts`'s job).
 */
function mockDexscreenerFound(): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      const address = decodeURIComponent(url.split("/").pop() ?? "");
      return {
        ok: true,
        status: 200,
        json: async () => [
          {
            chainId: "solana",
            url: `https://dexscreener.com/solana/${address}`,
            baseToken: { address, name: "Fixture Token", symbol: "FIX" },
            liquidity: { usd: 100_000 },
          },
        ],
      };
    }),
  );
}

/** No pair anywhere — DexScreener has never seen this address. */
function mockDexscreenerNotFound(): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => ({
      ok: true,
      status: 200,
      json: async () => (url.includes("/tokens/v1/") ? [] : { pairs: [] }),
    })),
  );
}

describe("POST /api/orders", () => {
  const originalPaymentWallet = process.env.PAYMENT_WALLET;
  const originalRateLimitMax = process.env.ORDER_RATE_LIMIT_MAX;
  const originalRateLimitWindow = process.env.ORDER_RATE_LIMIT_WINDOW_MINUTES;

  beforeEach(() => {
    process.env.PAYMENT_WALLET = PAYMENT_WALLET;
    delete process.env.ORDER_RATE_LIMIT_MAX;
    delete process.env.ORDER_RATE_LIMIT_WINDOW_MINUTES;
    mockDexscreenerFound();
  });

  afterEach(() => {
    if (originalPaymentWallet === undefined) delete process.env.PAYMENT_WALLET;
    else process.env.PAYMENT_WALLET = originalPaymentWallet;
    if (originalRateLimitMax === undefined) delete process.env.ORDER_RATE_LIMIT_MAX;
    else process.env.ORDER_RATE_LIMIT_MAX = originalRateLimitMax;
    if (originalRateLimitWindow === undefined) delete process.env.ORDER_RATE_LIMIT_WINDOW_MINUTES;
    else process.env.ORDER_RATE_LIMIT_WINDOW_MINUTES = originalRateLimitWindow;
    vi.unstubAllGlobals();
    delete (globalThis as { __dexCache?: unknown }).__dexCache;
  });

  it(
    "opens an order for a valid token, priced in lamports",
    { timeout: 20_000 },
    async () => {
      const war = await makeWar();

      const response = await ordersRoute(post("/api/orders", orderBody({ warSlug: war.slug })));

      expect(response.status).toBe(201);
      const body = await response.json();
      expect(body).toMatchObject({
        // The war fixture's price, in lamports, as a string — a bigint does
        // not survive JSON and a Number would be a float standing in for an
        // exact count of the smallest unit this product moves.
        amountLamports: "25000000",
        payTo: PAYMENT_WALLET,
      });
      expect(typeof body.orderId).toBe("string");
      expect(typeof body.reference).toBe("string");
      expect(new Date(body.expiresAt).getTime()).toBeGreaterThan(Date.now());
    },
  );

  it(
    "never puts anything server-side in the response",
    { timeout: 20_000 },
    async () => {
      const war = await makeWar();

      const response = await ordersRoute(post("/api/orders", orderBody({ warSlug: war.slug })));
      const body = await response.json();

      // Exactly the payer-facing fields — no ip_hash, no war_token_id, no
      // internal status, nothing the payer never submitted and has no
      // business seeing.
      // Exhaustive, and one field shorter than it was: `mint` went with the
      // USDC path, because a native transfer has no mint to name.
      expect(Object.keys(body).sort()).toEqual(
        ["amountLamports", "expiresAt", "orderId", "payTo", "reference"].sort(),
      );
    },
  );

  it(
    "mints a fresh, distinct reference for every order",
    { timeout: 20_000 },
    async () => {
      const war = await makeWar();

      const first = await ordersRoute(
        post("/api/orders", orderBody({ warSlug: war.slug, colourSlot: 1 })),
      );
      const second = await ordersRoute(
        post("/api/orders", orderBody({ warSlug: war.slug, colourSlot: 2 })),
      );

      const a = await first.json();
      const b = await second.json();
      expect(a.reference).not.toBe(b.reference);
    },
  );

  it(
    "allows entry before the war itself has started",
    { timeout: 20_000 },
    async () => {
      const war = await makeWar({
        status: "scheduled",
        startsAt: new Date(Date.now() + 3_600_000),
        endsAt: new Date(Date.now() + 7_200_000),
      });

      const response = await ordersRoute(post("/api/orders", orderBody({ warSlug: war.slug })));

      expect(response.status).toBe(201);
    },
  );

  it(
    "gives two entrants two different flags instead of refusing the second",
    { timeout: 20_000 },
    async () => {
      // This test used to assert a 409 `colour_taken`, which was the commonest
      // refusal in the product when a payer chose their own flag. Nobody
      // chooses now, so the second entrant is served rather than told to pick
      // again — the refusal survives only for a genuine race.
      const war = await makeWar();
      const first = await ordersRoute(post("/api/orders", orderBody({ warSlug: war.slug })));
      expect(first.status).toBe(201);

      const second = await ordersRoute(post("/api/orders", orderBody({ warSlug: war.slug })));
      expect(second.status).toBe(201);

      const slots = await query<{ colour_slot: number }>(
        `SELECT colour_slot FROM war_tokens WHERE war_id = $1 ORDER BY colour_slot`,
        [war.id],
      );
      expect(slots.map((row) => row.colour_slot)).toEqual([1, 2]);
    },
  );

  it(
    "409s with already_entered for a token already in this war",
    { timeout: 20_000 },
    async () => {
      const war = await makeWar();
      const contract = randomSolanaAddress();
      const first = await ordersRoute(
        post("/api/orders", orderBody({ warSlug: war.slug, colourSlot: 1, contract })),
      );
      expect(first.status).toBe(201);

      const second = await ordersRoute(
        post("/api/orders", orderBody({ warSlug: war.slug, colourSlot: 2, contract })),
      );

      expect(second.status).toBe(409);
      expect(await second.json()).toMatchObject({ reason: "already_entered" });
    },
  );

  it(
    "409s with war_full once every seat is taken",
    { timeout: 20_000 },
    async () => {
      const war = await makeWar({ maxTokens: 1 });
      const first = await ordersRoute(
        post("/api/orders", orderBody({ warSlug: war.slug, colourSlot: 1 })),
      );
      expect(first.status).toBe(201);

      const second = await ordersRoute(
        post("/api/orders", orderBody({ warSlug: war.slug, colourSlot: 2 })),
      );

      expect(second.status).toBe(409);
      expect(await second.json()).toMatchObject({ reason: "war_full" });
    },
  );

  it(
    "409s with war_closed for a war that has ended",
    { timeout: 20_000 },
    async () => {
      const war = await makeWar({
        status: "ended",
        startsAt: new Date(Date.now() - 7_200_000),
        endsAt: new Date(Date.now() - 3_600_000),
      });

      const response = await ordersRoute(post("/api/orders", orderBody({ warSlug: war.slug })));

      expect(response.status).toBe(409);
      expect(await response.json()).toMatchObject({ reason: "war_closed" });
    },
  );

  it(
    "400s for a malformed contract address",
    { timeout: 20_000 },
    async () => {
      const war = await makeWar();

      const response = await ordersRoute(
        post("/api/orders", orderBody({ warSlug: war.slug, contract: "not-a-real-address" })),
      );

      expect(response.status).toBe(400);
    },
  );

  it(
    "400s for an unknown chain, without ever calling DexScreener",
    { timeout: 20_000 },
    async () => {
      const war = await makeWar();
      const fetchSpy = vi.fn();
      vi.stubGlobal("fetch", fetchSpy);

      const response = await ordersRoute(
        post(
          "/api/orders",
          orderBody({ warSlug: war.slug, chainId: "not-a-chain", contract: "whatever" }),
        ),
      );

      expect(response.status).toBe(400);
      expect(fetchSpy).not.toHaveBeenCalled();
    },
  );

  it(
    "400s for a payer pubkey that is not a valid Solana address",
    { timeout: 20_000 },
    async () => {
      const war = await makeWar();

      const response = await ordersRoute(
        post(
          "/api/orders",
          orderBody({ warSlug: war.slug, payerPubkey: "definitely-not-base58!!" }),
        ),
      );

      expect(response.status).toBe(400);
    },
  );

  it(
    "gives an empty payerPubkey its own message, not the contract-address one",
    { timeout: 20_000 },
    async () => {
      const war = await makeWar();

      const response = await ordersRoute(
        post("/api/orders", orderBody({ warSlug: war.slug, payerPubkey: "" })),
      );

      expect(response.status).toBe(400);
      const body = await response.json();
      expect(body.error).toMatch(/payer/i);
      expect(body.error).not.toMatch(/contract/i);
    },
  );

  /**
   * Fix round 1, Finding 1 (Critical): `validateAddress` is called on both
   * `contract` and `payerPubkey` with no length check before it, and
   * `base58Decode` behind it is O(n^2) — the reviewer measured ~1s at
   * 50,000 characters and ~3.6s at 100,000, scaling quadratically, against
   * this exact route before the fix. An ordinary 1-2MB POST body is well
   * within any platform's request-size limit and comfortably carries a
   * 200,000-character string, so a handful of concurrent requests like this
   * used to pin a serverless function's budget on the endpoint that takes
   * money. Both fields are timed here, not just checked for a 400: the DB
   * fixture (`makeWar`) is allowed the suite's usual 20s ceiling for a slow
   * network hop, but the route call itself is asserted well under a second,
   * so a regression back to quadratic behaviour fails on time, not just
   * eventually returns the right status.
   */
  it(
    "400s promptly for an enormous contract address",
    { timeout: 20_000 },
    async () => {
      const war = await makeWar();
      const huge = "A".repeat(200_000);

      const started = Date.now();
      const response = await ordersRoute(
        post("/api/orders", orderBody({ warSlug: war.slug, contract: huge })),
      );
      const elapsedMs = Date.now() - started;

      expect(response.status).toBe(400);
      expect(elapsedMs).toBeLessThan(1_000);
    },
  );

  it(
    "400s promptly for an enormous payerPubkey",
    { timeout: 20_000 },
    async () => {
      const war = await makeWar();
      const huge = "A".repeat(200_000);

      const started = Date.now();
      const response = await ordersRoute(
        post("/api/orders", orderBody({ warSlug: war.slug, payerPubkey: huge })),
      );
      const elapsedMs = Date.now() - started;

      expect(response.status).toBe(400);
      expect(elapsedMs).toBeLessThan(1_000);
    },
  );

  it(
    "404s for a war that does not exist",
    { timeout: 20_000 },
    async () => {
      const response = await ordersRoute(
        post("/api/orders", orderBody({ warSlug: "no-such-war" })),
      );

      expect(response.status).toBe(404);
    },
  );

  it(
    "404s for a token DexScreener has never seen",
    { timeout: 20_000 },
    async () => {
      mockDexscreenerNotFound();
      const war = await makeWar();

      const response = await ordersRoute(post("/api/orders", orderBody({ warSlug: war.slug })));

      expect(response.status).toBe(404);
    },
  );

  it(
    "refuses to open orders when no client address can be trusted",
    { timeout: 20_000 },
    async () => {
      const previous = process.env.ALLOW_UNTRUSTED_CLIENT_IP;
      delete process.env.ALLOW_UNTRUSTED_CLIENT_IP;

      try {
        const war = await makeWar();
        const response = await ordersRoute(
          new Request("https://pixelwar.fun/api/orders", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(orderBody({ warSlug: war.slug })),
          }),
        );

        expect(response.status).toBe(400);
      } finally {
        if (previous === undefined) delete process.env.ALLOW_UNTRUSTED_CLIENT_IP;
        else process.env.ALLOW_UNTRUSTED_CLIENT_IP = previous;
      }
    },
  );

  it(
    "429s once one address opens more orders than the window allows",
    { timeout: 20_000 },
    async () => {
      process.env.ORDER_RATE_LIMIT_MAX = "2";
      const war = await makeWar({ maxTokens: 10 });

      const first = await ordersRoute(
        post("/api/orders", orderBody({ warSlug: war.slug, colourSlot: 1 }), "9.9.9.9"),
      );
      const second = await ordersRoute(
        post("/api/orders", orderBody({ warSlug: war.slug, colourSlot: 2 }), "9.9.9.9"),
      );
      const third = await ordersRoute(
        post("/api/orders", orderBody({ warSlug: war.slug, colourSlot: 3 }), "9.9.9.9"),
      );

      expect(first.status).toBe(201);
      expect(second.status).toBe(201);
      expect(third.status).toBe(429);

      // A different address is a different bucket, unaffected by the first
      // address's count.
      const other = await ordersRoute(
        post("/api/orders", orderBody({ warSlug: war.slug, colourSlot: 4 }), "1.1.1.1"),
      );
      expect(other.status).toBe(201);
    },
  );
});

describe("GET /api/orders/[id]", () => {
  const originalPaymentWallet = process.env.PAYMENT_WALLET;

  beforeEach(() => {
    process.env.PAYMENT_WALLET = PAYMENT_WALLET;
    mockDexscreenerFound();
  });

  afterEach(() => {
    if (originalPaymentWallet === undefined) delete process.env.PAYMENT_WALLET;
    else process.env.PAYMENT_WALLET = originalPaymentWallet;
    vi.unstubAllGlobals();
    delete (globalThis as { __dexCache?: unknown }).__dexCache;
  });

  it(
    "reports a freshly opened order's status",
    { timeout: 20_000 },
    async () => {
      const war = await makeWar();
      const opened = await ordersRoute(post("/api/orders", orderBody({ warSlug: war.slug })));
      const { orderId } = await opened.json();

      const response = await getOrderRoute(get(`/api/orders/${orderId}`), {
        params: Promise.resolve({ id: orderId }),
      });

      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({
        status: "pending",
        amountLamports: "25000000",
        paidAt: null,
        tokenTicker: "FIX",
        // The first free flag, assigned rather than requested.
        colourSlot: 1,
      });
    },
  );

  it(
    "404s for an order id that does not exist",
    { timeout: 20_000 },
    async () => {
      const response = await getOrderRoute(get(`/api/orders/${randomUUID()}`), {
        params: Promise.resolve({ id: randomUUID() }),
      });

      expect(response.status).toBe(404);
    },
  );
});

import { randomBytes, randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { base58Encode } from "../../../lib/base58";
import { execute } from "../../../lib/db";
import { createOrder } from "../../../lib/payments/orders";
import { POST as confirmRoute } from "../orders/[id]/confirm/route";

/**
 * The endpoint that turns a signature into a paid order: POST
 * /api/orders/:id/confirm. Settlement itself (the atomic payment + order +
 * token flip, every race it survives) is proven against the database
 * directly in `lib/payments/__tests__/settle.test.ts`; this file proves the
 * route wires identify(), rate limiting, `verifyPayment` and `settlePayment`
 * together the way a real request needs.
 */

const PAYMENT_WALLET = "7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU";

function randomSignature(): string {
  return base58Encode(new Uint8Array(randomBytes(64)));
}

function post(path: string, body: unknown, ip = "1.2.3.4"): Request {
  return new Request(`https://pixelwar.fun${path}`, {
    method: "POST",
    headers: { "x-forwarded-for": ip, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

/**
 * A `getTransaction`-shaped RPC result whose NATIVE balances credit
 * `PAYMENT_WALLET` with `amount` lamports, paid by `payer`, inside the
 * supplied order's window (the caller passes one that already is).
 *
 * Positional, like the chain's own: entry N belongs to `accountKeys[N]`. The
 * payer's own drop is the amount PLUS a network fee, which is exactly why the
 * verifier reads the recipient's rise instead.
 */
function fixtureTransaction(options: {
  amount: string;
  payer: string;
  blockTimeMs: number;
  err?: unknown;
}) {
  const amount = BigInt(options.amount);
  return {
    slot: 1,
    blockTime: Math.floor(options.blockTimeMs / 1000),
    transaction: {
      message: {
        accountKeys: [
          { pubkey: options.payer, signer: true },
          { pubkey: PAYMENT_WALLET, signer: false },
        ],
      },
    },
    meta: {
      err: options.err ?? null,
      preBalances: [500_000_000, 0],
      postBalances: [Number(500_000_000n - amount - 5_000n), Number(amount)],
    },
  };
}

/** Stubs global fetch to answer every RPC call with the same fixture result. */
function mockRpc(result: unknown | null): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn(async () => ({
    ok: true,
    status: 200,
    json: async () => ({ jsonrpc: "2.0", id: 1, result }),
  }));
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

async function makeWar(overrides: Partial<{ maxTokens: number; entryPriceUsd: number }> = {}): Promise<{
  id: string;
  slug: string;
}> {
  const id = randomUUID();
  await execute(
    `INSERT INTO wars (id, slug, title, status, width, height, max_tokens,
                        entry_price_usd, entry_price_sol, cooldown_seconds, starts_at, ends_at)
     VALUES ($1, $1, 'Fixture war', 'live', 100, 100, $2, $3, 25000000, 30,
             now() - interval '1 hour', now() + interval '1 hour')`,
    [id, overrides.maxTokens ?? 24, overrides.entryPriceUsd ?? 25],
  );
  return { id, slug: id };
}

async function makeOrder(warId: string, overrides: Partial<{ payerPubkey: string }> = {}) {
  const result = await createOrder({
    warId,
    chainId: "solana",
    contract: randomUUID(),
    contractKey: randomUUID(),
    name: "Fixture Token",
    ticker: "FIX",
    referencePubkey: randomUUID(),
    payerPubkey: overrides.payerPubkey,
  });
  if (!result.ok) throw new Error(`fixture order failed: ${result.reason}`);
  return result.order;
}

describe("POST /api/orders/:id/confirm", () => {
  const originalPaymentWallet = process.env.PAYMENT_WALLET;

  beforeEach(() => {
    process.env.PAYMENT_WALLET = PAYMENT_WALLET;
  });

  afterEach(() => {
    if (originalPaymentWallet === undefined) delete process.env.PAYMENT_WALLET;
    else process.env.PAYMENT_WALLET = originalPaymentWallet;
    vi.unstubAllGlobals();
  });

  it(
    "confirms a real payment and marks the order paid",
    { timeout: 20_000 },
    async () => {
      const war = await makeWar();
      const order = await makeOrder(war.id);
      mockRpc(
        fixtureTransaction({
          amount: "25000000",
          payer: "SomeRandomPayerAddress1111111111111111111111",
          blockTimeMs: Date.now(),
        }),
      );

      const response = await confirmRoute(
        post(`/api/orders/${order.id}/confirm`, { signature: randomSignature() }),
        { params: Promise.resolve({ id: order.id }) },
      );

      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body).toMatchObject({ status: "paid", amountLamports: "25000000", amountReceivedBaseUnits: "25000000" });
    },
  );

  it(
    "404s for an order that does not exist",
    { timeout: 20_000 },
    async () => {
      const response = await confirmRoute(
        post(`/api/orders/does-not-exist/confirm`, { signature: randomSignature() }),
        { params: Promise.resolve({ id: "does-not-exist" }) },
      );

      expect(response.status).toBe(404);
    },
  );

  it(
    "400s for a missing signature",
    { timeout: 20_000 },
    async () => {
      const war = await makeWar();
      const order = await makeOrder(war.id);

      const response = await confirmRoute(post(`/api/orders/${order.id}/confirm`, {}), {
        params: Promise.resolve({ id: order.id }),
      });

      expect(response.status).toBe(400);
    },
  );

  it(
    "400s for an oversized signature without ever reaching the network",
    { timeout: 20_000 },
    async () => {
      const war = await makeWar();
      const order = await makeOrder(war.id);
      const fetchMock = mockRpc(null);

      const response = await confirmRoute(
        post(`/api/orders/${order.id}/confirm`, { signature: "x".repeat(500) }),
        { params: Promise.resolve({ id: order.id }) },
      );

      expect(response.status).toBe(400);
      expect(fetchMock).not.toHaveBeenCalled();
    },
  );

  it(
    "rejects a payment paid from the wrong wallet",
    { timeout: 20_000 },
    async () => {
      const war = await makeWar();
      const order = await makeOrder(war.id, { payerPubkey: "ExpectedWallet111111111111111111111111111" });
      mockRpc(
        fixtureTransaction({
          amount: "25000000",
          payer: "SomeoneElseEntirely11111111111111111111111",
          blockTimeMs: Date.now(),
        }),
      );

      const response = await confirmRoute(
        post(`/api/orders/${order.id}/confirm`, { signature: randomSignature() }),
        { params: Promise.resolve({ id: order.id }) },
      );

      expect(response.status).toBe(400);
      const body = await response.json();
      expect(body.reason).toBe("wrong_payer");
    },
  );

  it(
    "500s when the deployment has no payment wallet configured",
    { timeout: 20_000 },
    async () => {
      const war = await makeWar();
      const order = await makeOrder(war.id);
      delete process.env.PAYMENT_WALLET;

      const response = await confirmRoute(
        post(`/api/orders/${order.id}/confirm`, { signature: randomSignature() }),
        { params: Promise.resolve({ id: order.id }) },
      );

      expect(response.status).toBe(500);
    },
  );

  it(
    "rate limits repeated verification attempts against the same order, before spending an RPC call",
    { timeout: 20_000 },
    async () => {
      const war = await makeWar();
      const order = await makeOrder(war.id);
      // Not confirmed yet — a real, if unlucky, verification outcome; what
      // matters is that the SECOND call is refused before it ever asks.
      const fetchMock = mockRpc(null);

      const first = await confirmRoute(
        post(`/api/orders/${order.id}/confirm`, { signature: randomSignature() }),
        { params: Promise.resolve({ id: order.id }) },
      );
      expect(first.status).toBe(409);
      expect(fetchMock).toHaveBeenCalledTimes(1);

      const second = await confirmRoute(
        post(`/api/orders/${order.id}/confirm`, { signature: randomSignature() }),
        { params: Promise.resolve({ id: order.id }) },
      );

      expect(second.status).toBe(429);
      // The rate limit was checked and refused before any RPC call: the
      // call count from the first attempt did not grow.
      expect(fetchMock).toHaveBeenCalledTimes(1);
    },
  );
});

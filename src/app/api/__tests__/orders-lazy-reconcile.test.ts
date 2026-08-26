import { randomBytes, randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { base58Encode } from "../../../lib/base58";
import { execute } from "../../../lib/db";
import { USDC_MINT } from "../../../lib/payments/config";
import { orderById } from "../../../lib/payments/orders";
import type { SolanaTransaction } from "../../../lib/payments/solana";

/**
 * THE WIRING TEST, and the one this whole batch exists for.
 *
 * `lazy-recovery.test.ts` proves the pass does the right thing when called.
 * That is not the property that was broken. What was broken is that calling
 * it was an external scheduler's job, and the scheduler did not show up on
 * time — 2h29m between two runs of a five-minute schedule, against a
 * ten-minute grace window.
 *
 * So this file drives the CALLER and asserts the EFFECT, per the repo's own
 * rule about unit tests that cannot catch a missing call site. Nothing here
 * touches `/api/cron/reconcile`. If reconciliation ever goes back to
 * depending on something outside a request arriving punctually, the first
 * test below fails, and it fails for the right reason: a real payment sat on
 * chain, a payer asked about their order, and nothing found it.
 *
 * Falsify it by deleting the `after(...)` block in
 * `src/app/api/orders/[id]/route.ts`.
 */

/**
 * `after` as the platform actually behaves: the callback is STARTED and the
 * response is NOT held for it.
 *
 * Deliberately not a capture-only mock. A mock that merely records the
 * callback would make the latency test below tautological — the handler
 * cannot be slowed by work that was never started. Starting it for real is
 * what makes "the response does not wait" a claim with something behind it,
 * and it is what makes the test fail if somebody changes `after(cb)` to
 * `await cb()`.
 */
const afterMode = vi.hoisted(() => ({ current: "run" as "run" | "throw" }));
const pending = vi.hoisted(() => [] as Array<Promise<unknown>>);

vi.mock("next/server", () => ({
  after: (callback: () => Promise<unknown>) => {
    // Next throws exactly this when `after` is called outside a request
    // scope, and one of the tests below needs that to happen on purpose.
    if (afterMode.current === "throw") {
      throw new Error("`after` was called outside a request scope.");
    }
    pending.push(Promise.resolve().then(callback));
  },
}));

/** Waits for whatever `after` started, so assertions see a finished pass. */
async function drainAfter(): Promise<void> {
  while (pending.length) await pending.shift();
}

/**
 * The fixture chain, injected at the ONE boundary that already takes a
 * fetcher in production: `recoverOrder`.
 *
 * Deliberately not mocking `scheduleReconcile` or `reconcileOnRead`. Those
 * are the links this file is testing — the route reaching the scheduler, the
 * scheduler expiring and claiming — and a test that replaces them proves the
 * route calls a mock. Everything above `recoverOrder` is the real code path.
 */
const recoveryFetcher = vi.hoisted(() => ({ current: {} as Record<string, unknown> }));
vi.mock("../../../lib/payments/recover", async (importOriginal) => {
  const real = await importOriginal<typeof import("../../../lib/payments/recover")>();
  return {
    ...real,
    recoverOrder: (orderId: string) => real.recoverOrder(orderId, recoveryFetcher.current),
  };
});

const { GET: orderRoute } = await import("../orders/[id]/route");

const PAYMENT_WALLET = "7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU";

function poll(id: string): Promise<Response> {
  return orderRoute(new Request(`https://pixelwar.fun/api/orders/${id}`), {
    params: Promise.resolve({ id }),
  });
}

function fixtureTransaction(): SolanaTransaction {
  const payer = "SomeRandomPayerAddress1111111111111111111111";
  return {
    slot: 1,
    blockTime: Math.floor((Date.now() - 30 * 60_000) / 1000),
    transaction: { message: { accountKeys: [{ pubkey: payer, signer: true }] } },
    meta: {
      err: null,
      preTokenBalances: [
        { accountIndex: 0, owner: PAYMENT_WALLET, mint: USDC_MINT, uiTokenAmount: { amount: "0" } },
        { accountIndex: 1, owner: payer, mint: USDC_MINT, uiTokenAmount: { amount: "500000000" } },
      ],
      postTokenBalances: [
        { accountIndex: 0, owner: PAYMENT_WALLET, mint: USDC_MINT, uiTokenAmount: { amount: "25000000" } },
        { accountIndex: 1, owner: payer, mint: USDC_MINT, uiTokenAmount: { amount: "475000000" } },
      ],
    },
  };
}

async function abandonedPayment(): Promise<{ orderId: string; reference: string }> {
  const warId = randomUUID();
  await execute(
    `INSERT INTO wars (id, slug, title, status, width, height, max_tokens,
                       entry_price_usd, cooldown_seconds, starts_at, ends_at)
     VALUES ($1, $1, 'Fixture war', 'live', 8, 8, 24, 25, 30, $2, $3)`,
    [warId, new Date(Date.now() - 3_600_000), new Date(Date.now() + 3_600_000)],
  );
  const tokenId = randomUUID();
  await execute(
    `INSERT INTO war_tokens
       (id, war_id, chain_id, contract, contract_key, colour_slot, status,
        name, ticker, metadata_fetched_at, reserved_at, released_at, released_reason)
     VALUES ($1, $2, 'solana', $1, $3, 1, 'released', 'Fixture', 'FIX', now(), now(), now(), 'order_expired')`,
    [tokenId, warId, randomUUID()],
  );
  const orderId = randomUUID();
  const reference = randomUUID();
  await execute(
    `INSERT INTO entry_orders
       (id, war_id, war_token_id, amount_usd, payer_pubkey, reference_pubkey, status,
        created_at, expires_at)
     VALUES ($1, $2, $3, 25, NULL, $4, 'expired', $5, $6)`,
    [orderId, warId, tokenId, reference, new Date(Date.now() - 3_600_000), new Date(Date.now() - 120_000)],
  );
  return { orderId, reference };
}

describe("GET /api/orders/[id] reconciles without a scheduler", () => {
  beforeEach(() => {
    pending.length = 0;
    afterMode.current = "run";
    process.env.PAYMENT_WALLET = PAYMENT_WALLET;
    recoveryFetcher.current = {};
  });

  it(
    "finds an abandoned payment because the payer asked, not because a cron ran",
    { timeout: 30_000 },
    async () => {
      const { orderId, reference } = await abandonedPayment();
      const signature = base58Encode(new Uint8Array(randomBytes(64)));
      recoveryFetcher.current = {
        signatures: async (ref: string) =>
          ref === reference
            ? [{ signature, blockTime: Math.floor(Date.now() / 1000) - 1800 }]
            : [],
        transaction: async () => fixtureTransaction(),
      };

      expect((await orderById(orderId))!.status).toBe("expired");

      const response = await poll(orderId);
      expect(response.status).toBe(200);
      await drainAfter();

      // The money was on chain the whole time. Nothing scheduled ran.
      expect((await orderById(orderId))!.status).toBe("paid");
    },
  );

  it(
    "does not let the recovery pass lengthen the poll",
    { timeout: 30_000 },
    async () => {
      // REQUIREMENT: the lazy pass must not make the poll slower than it
      // already is. `after` is what guarantees that, and this is the number
      // behind the guarantee.
      const { orderId, reference } = await abandonedPayment();
      const PASS_DELAY_MS = 1_000;
      recoveryFetcher.current = {
        signatures: async (ref: string) => {
          await new Promise((r) => setTimeout(r, PASS_DELAY_MS));
          return ref === reference ? [] : [];
        },
      };

      // Baseline: the same poll with nothing to reconcile behind it.
      const paidId = (await abandonedPayment()).orderId;
      await execute(`UPDATE entry_orders SET status = 'paid' WHERE id = $1`, [paidId]);
      const baseStart = performance.now();
      await poll(paidId);
      const baseline = performance.now() - baseStart;

      const start = performance.now();
      const response = await poll(orderId);
      const withPass = performance.now() - start;
      expect(response.status).toBe(200);

      console.log(
        `\n  [latencia del poll]  sin pasada: ${baseline.toFixed(1)}ms  ` +
          `con pasada de ${PASS_DELAY_MS}ms detras: ${withPass.toFixed(1)}ms  ` +
          `delta: ${(withPass - baseline).toFixed(1)}ms\n`,
      );

      // The response must not have waited for the pass. Half the pass's own
      // delay is a deliberately loose bar: the point is the difference
      // between "did not wait at all" and "waited", not a millisecond budget.
      expect(withPass).toBeLessThan(PASS_DELAY_MS / 2);

      await drainAfter();
    },
  );

  it(
    "still answers 200 when after() itself throws",
    { timeout: 30_000 },
    async () => {
      // THE REGRESSION THE FULL SUITE FOUND. `after` throws when it is called
      // outside a request scope, and an uncaught throw would come from the
      // handler body — before any response exists — turning an ordinary
      // status poll into a 500. The promise this mechanism makes is that a
      // failing reconcile costs a payer one poll cycle and nothing else; a
      // throw from the SCHEDULING call breaks that promise just as
      // effectively as a throw from the work.
      const { orderId } = await abandonedPayment();
      afterMode.current = "throw";

      const response = await poll(orderId);

      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ status: "expired" });
    },
  );
});

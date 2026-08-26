import { randomBytes, randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { base58Encode } from "../../base58";
import { execute, query, queryOne } from "../../db";
import type { War } from "../../wars/lifecycle";
import { USDC_MINT } from "../config";
import { orderById, type Order } from "../orders";
import { recoverUnclaimedOrders, type RecoveryFetcher } from "../recover";
import type { SolanaTransaction } from "../solana";

/**
 * The payoff for the reference key: a payer signs, closes the tab before
 * `/confirm` ever runs, and the money sits in our wallet with no order the
 * wiser. Every test here drives `recoverUnclaimedOrders` with a fabricated
 * chain — no network, ever — and proves it against the real database, the
 * same way `settle.test.ts` proves `settlePayment` itself.
 *
 * Settlement's own races and atomicity are already proven in
 * `settle.test.ts`; this file is about the part unique to recovery: finding
 * the right expired order, finding its signature by reference rather than by
 * a submitted string, trying candidates in order, and never touching an
 * order recovery cannot help.
 */

const PAYMENT_WALLET = "7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU";

function randomSignature(): string {
  return base58Encode(new Uint8Array(randomBytes(64)));
}

async function war(
  overrides: Partial<{ maxTokens: number; status: string; startsAt: Date; endsAt: Date }> = {},
): Promise<War> {
  const id = randomUUID();
  await execute(
    `INSERT INTO wars (id, slug, title, status, width, height, max_tokens,
                        entry_price_usd, cooldown_seconds, starts_at, ends_at)
     VALUES ($1, $1, 'Fixture war', $2, 8, 8, $3, 25, 30, $4, $5)`,
    [
      id,
      overrides.status ?? "live",
      overrides.maxTokens ?? 24,
      overrides.startsAt ?? new Date(Date.now() - 3_600_000),
      overrides.endsAt ?? new Date(Date.now() + 3_600_000),
    ],
  );
  const row = await queryOne<{
    id: string;
    slug: string;
    title: string;
    status: string;
    width: number;
    height: number;
    max_tokens: number;
    entry_price_usd: number;
    cooldown_seconds: number;
    starts_at: Date;
    ends_at: Date;
    last_seq: string;
    ended_at: Date | null;
  }>(`SELECT * FROM wars WHERE id = $1`, [id]);
  return {
    id: row!.id,
    slug: row!.slug,
    title: row!.title,
    status: row!.status as War["status"],
    width: row!.width,
    height: row!.height,
    maxTokens: row!.max_tokens,
    entryPriceUsd: row!.entry_price_usd,
    cooldownSeconds: row!.cooldown_seconds,
    startsAt: row!.starts_at,
    endsAt: row!.ends_at,
    lastSeq: Number(row!.last_seq),
    endedAt: row!.ended_at,
  };
}

async function insertToken(overrides: {
  warId: string;
  colourSlot: number;
  status: "reserved" | "active" | "removed" | "released";
  contractKey?: string;
}): Promise<string> {
  const id = randomUUID();
  await execute(
    `INSERT INTO war_tokens
       (id, war_id, chain_id, contract, contract_key, colour_slot, status,
        name, ticker, metadata_fetched_at, reserved_at, joined_at, released_at, released_reason)
     VALUES ($1, $2, 'solana', $1, $3, $4, $5, 'Fixture', 'FIX', now(), now(),
             CASE WHEN $5 IN ('active','removed') THEN now() ELSE NULL END,
             CASE WHEN $5 IN ('removed','released') THEN now() ELSE NULL END,
             CASE WHEN $5 = 'removed' THEN 'pulled_by_operator'
                  WHEN $5 = 'released' THEN 'order_expired' ELSE NULL END)`,
    [id, overrides.warId, overrides.contractKey ?? randomUUID(), overrides.colourSlot, overrides.status],
  );
  return id;
}

/** Inserts an order whose window has already closed and flips it to 'expired' — recovery's own starting point. */
async function expiredOrder(overrides: {
  warId: string;
  warTokenId: string;
  amountUsd?: number;
  payerPubkey?: string | null;
  referencePubkey?: string;
  expiredMinutesAgo?: number;
  /**
   * Defaults to an hour ago, which is before every default expiry below. An
   * order whose expiry is days old needs its creation moved back with it, or
   * the fixture describes an order that expired before it existed.
   */
  createdMinutesAgo?: number;
}) {
  const id = randomUUID();
  await execute(
    `INSERT INTO entry_orders
       (id, war_id, war_token_id, amount_usd, payer_pubkey, reference_pubkey, status,
        created_at, expires_at)
     VALUES ($1, $2, $3, $4, $5, $6, 'expired', $7, $8)`,
    [
      id,
      overrides.warId,
      overrides.warTokenId,
      overrides.amountUsd ?? 25,
      overrides.payerPubkey ?? null,
      overrides.referencePubkey ?? randomUUID(),
      new Date(Date.now() - (overrides.createdMinutesAgo ?? 60) * 60_000),
      new Date(Date.now() - (overrides.expiredMinutesAgo ?? 2) * 60_000),
    ],
  );
  return (await orderById(id))!;
}

/**
 * A `getTransaction`-shaped RPC result whose token balance deltas credit
 * `PAYMENT_WALLET` with `amount` USDC from `payer`. `blockTimeMs` defaults to
 * a time comfortably inside `expiredOrder`'s own created/expired window
 * (created an hour ago, expired minutes ago) so most tests below are not
 * incidentally exercising the widened-window behaviour — the dedicated
 * "closes the outside_bid_window gap" test overrides it on purpose, with a
 * block time well outside that window, to prove that specific case.
 */
function fixtureTransaction(options: {
  amount: string;
  payer?: string;
  blockTimeMs?: number;
  err?: unknown;
}): SolanaTransaction {
  const payer = options.payer ?? "SomeRandomPayerAddress1111111111111111111111";
  return {
    slot: 1,
    blockTime: Math.floor((options.blockTimeMs ?? Date.now() - 30 * 60_000) / 1000),
    transaction: { message: { accountKeys: [{ pubkey: payer, signer: true }] } },
    meta: {
      err: options.err ?? null,
      preTokenBalances: [
        { accountIndex: 0, owner: PAYMENT_WALLET, mint: USDC_MINT, uiTokenAmount: { amount: "0" } },
        { accountIndex: 1, owner: payer, mint: USDC_MINT, uiTokenAmount: { amount: "500000000" } },
      ],
      postTokenBalances: [
        { accountIndex: 0, owner: PAYMENT_WALLET, mint: USDC_MINT, uiTokenAmount: { amount: options.amount } },
        {
          accountIndex: 1,
          owner: payer,
          mint: USDC_MINT,
          uiTokenAmount: { amount: (500_000_000n - BigInt(options.amount)).toString() },
        },
      ],
    },
  };
}

/**
 * Builds a fetcher from plain maps: reference -> its signatures (newest
 * first, exactly as given), signature -> its transaction. `blockTime` is
 * always `null` — every array here is far shorter than `SIGNATURE_PAGE_SIZE`,
 * so `collectOldestCandidates` always stops after the single page this
 * returns regardless of `before`, the same as it did before paging existed.
 * Tests that need genuine multi-page behaviour build their own fetcher
 * instead — see the "pages backward" and "page ceiling" tests below.
 */
function mapFetcher(
  signaturesByReference: Record<string, string[]>,
  transactionsBySignature: Record<string, SolanaTransaction>,
): RecoveryFetcher {
  return {
    signatures: async (reference) =>
      (signaturesByReference[reference] ?? []).map((signature) => ({ signature, blockTime: null })),
    transaction: async (signature) => transactionsBySignature[signature] ?? null,
  };
}

/**
 * Creates `count` expired orders in `w`, each with its own released colour
 * and a genuine payment that would settle it if examined, plus the fetcher
 * maps that cover all of them. Used by the tests that need more candidates
 * than fit in one pass, or need one real order lost among others.
 */
async function manyResolvableOrders(
  w: War,
  count: number,
  startColour: number,
  expiredMinutesAgo: (index: number) => number = () => 2,
): Promise<{
  orders: Order[];
  signaturesByReference: Record<string, string[]>;
  transactionsBySignature: Record<string, SolanaTransaction>;
}> {
  const orders: Order[] = [];
  const signaturesByReference: Record<string, string[]> = {};
  const transactionsBySignature: Record<string, SolanaTransaction> = {};

  for (let i = 0; i < count; i++) {
    const tokenId = await insertToken({ warId: w.id, colourSlot: startColour + i, status: "released" });
    const order = await expiredOrder({
      warId: w.id,
      warTokenId: tokenId,
      expiredMinutesAgo: expiredMinutesAgo(i),
    });
    const signature = randomSignature();
    signaturesByReference[order.referencePubkey] = [signature];
    transactionsBySignature[signature] = fixtureTransaction({ amount: "25000000" });
    orders.push(order);
  }

  return { orders, signaturesByReference, transactionsBySignature };
}

describe("recoverUnclaimedOrders", () => {
  const originalPaymentWallet = process.env.PAYMENT_WALLET;

  beforeEach(() => {
    process.env.PAYMENT_WALLET = PAYMENT_WALLET;
  });

  afterEach(() => {
    if (originalPaymentWallet === undefined) delete process.env.PAYMENT_WALLET;
    else process.env.PAYMENT_WALLET = originalPaymentWallet;
  });

  it(
    "settles an expired order whose payment did arrive",
    { timeout: 20_000 },
    async () => {
      const w = await war();
      const tokenId = await insertToken({ warId: w.id, colourSlot: 5, status: "released" });
      const order = await expiredOrder({ warId: w.id, warTokenId: tokenId });
      const signature = randomSignature();

      const result = await recoverUnclaimedOrders(
        mapFetcher(
          { [order.referencePubkey]: [signature] },
          { [signature]: fixtureTransaction({ amount: "25000000" }) },
        ),
      );

      expect(result.recovered).toEqual([order.id]);
      expect(result.filed).toEqual([]);

      const refreshed = await orderById(order.id);
      expect(refreshed?.status).toBe("paid");
      expect(refreshed?.paidAt).toBeTruthy();

      const [paymentRow] = await query<{ signature: string; order_id: string }>(
        `SELECT signature, order_id FROM payments WHERE order_id = $1`,
        [order.id],
      );
      expect(paymentRow).toMatchObject({ signature, order_id: order.id });
    },
  );

  it(
    "re-takes the colour when it is still free",
    { timeout: 20_000 },
    async () => {
      const w = await war();
      const tokenId = await insertToken({ warId: w.id, colourSlot: 7, status: "released" });
      const order = await expiredOrder({ warId: w.id, warTokenId: tokenId });
      const signature = randomSignature();

      await recoverUnclaimedOrders(
        mapFetcher(
          { [order.referencePubkey]: [signature] },
          { [signature]: fixtureTransaction({ amount: "25000000" }) },
        ),
      );

      const [tokenRow] = await query<{ status: string; joined_at: Date | null; colour_slot: number }>(
        `SELECT status, joined_at, colour_slot FROM war_tokens WHERE id = $1`,
        [tokenId],
      );
      expect(tokenRow).toMatchObject({ status: "active", colour_slot: 7 });
      expect(tokenRow.joined_at).toBeTruthy();
    },
  );

  it(
    "files the payment for support when the colour was taken",
    { timeout: 20_000 },
    async () => {
      const w = await war({ maxTokens: 3 });
      const tokenId = await insertToken({ warId: w.id, colourSlot: 2, status: "released" });
      const order = await expiredOrder({ warId: w.id, warTokenId: tokenId });
      // Someone else took colour 2 with a fresh reservation while this
      // payment was in flight.
      await insertToken({ warId: w.id, colourSlot: 2, status: "active" });
      const signature = randomSignature();

      const result = await recoverUnclaimedOrders(
        mapFetcher(
          { [order.referencePubkey]: [signature] },
          { [signature]: fixtureTransaction({ amount: "25000000" }) },
        ),
      );

      expect(result.recovered).toEqual([]);
      expect(result.filed).toEqual([order.id]);

      const refreshed = await orderById(order.id);
      expect(refreshed?.status).toBe("expired");

      const [unmatchedRow] = await query<{ reason: string; received_base_units: string }>(
        `SELECT reason, received_base_units FROM unmatched_payments WHERE order_id = $1`,
        [order.id],
      );
      expect(unmatchedRow).toMatchObject({ reason: "colour_taken", received_base_units: "25000000" });
    },
  );

  it(
    "files it when the war filled up or ended",
    { timeout: 20_000 },
    async () => {
      // War A: this order's own colour (1) is not the one in conflict —
      // capacity is. The war's one seat has since gone to colour 2.
      const warA = await war({ maxTokens: 1 });
      const tokenA = await insertToken({ warId: warA.id, colourSlot: 1, status: "released" });
      const orderFull = await expiredOrder({ warId: warA.id, warTokenId: tokenA });
      await insertToken({ warId: warA.id, colourSlot: 2, status: "active" });

      // War B: the war itself ended while the payment was in flight.
      const warB = await war();
      const tokenB = await insertToken({ warId: warB.id, colourSlot: 4, status: "released" });
      const orderEnded = await expiredOrder({ warId: warB.id, warTokenId: tokenB });
      await execute(`UPDATE wars SET status = 'ended', ended_at = now() WHERE id = $1`, [warB.id]);

      const sigFull = randomSignature();
      const sigEnded = randomSignature();

      const result = await recoverUnclaimedOrders(
        mapFetcher(
          {
            [orderFull.referencePubkey]: [sigFull],
            [orderEnded.referencePubkey]: [sigEnded],
          },
          {
            [sigFull]: fixtureTransaction({ amount: "25000000" }),
            [sigEnded]: fixtureTransaction({ amount: "25000000" }),
          },
        ),
      );

      expect(result.recovered).toEqual([]);
      expect(result.filed.sort()).toEqual([orderEnded.id, orderFull.id].sort());

      const [fullRow] = await query<{ reason: string }>(
        `SELECT reason FROM unmatched_payments WHERE order_id = $1`,
        [orderFull.id],
      );
      expect(fullRow.reason).toBe("war_full");

      const [endedRow] = await query<{ reason: string }>(
        `SELECT reason FROM unmatched_payments WHERE order_id = $1`,
        [orderEnded.id],
      );
      expect(endedRow.reason).toBe("war_closed");
    },
  );

  it(
    "leaves an order alone when the chain knows nothing about its reference",
    { timeout: 20_000 },
    async () => {
      const w = await war();
      const tokenId = await insertToken({ warId: w.id, colourSlot: 5, status: "released" });
      const order = await expiredOrder({ warId: w.id, warTokenId: tokenId });

      const result = await recoverUnclaimedOrders(mapFetcher({}, {}));

      expect(result.recovered).toEqual([]);
      expect(result.filed).toEqual([]);

      const refreshed = await orderById(order.id);
      expect(refreshed?.status).toBe("expired");
      const [tokenRow] = await query<{ status: string }>(`SELECT status FROM war_tokens WHERE id = $1`, [
        tokenId,
      ]);
      expect(tokenRow.status).toBe("released");
    },
  );

  it(
    "is idempotent — a second pass settles nothing twice",
    { timeout: 20_000 },
    async () => {
      const w = await war();
      const tokenId = await insertToken({ warId: w.id, colourSlot: 5, status: "released" });
      const order = await expiredOrder({ warId: w.id, warTokenId: tokenId });
      const signature = randomSignature();

      // The same fetcher, unmodified, for both passes — nothing here tracks
      // "already handled"; the order's own status is what has to do that.
      const fetcher = mapFetcher(
        { [order.referencePubkey]: [signature] },
        { [signature]: fixtureTransaction({ amount: "25000000" }) },
      );

      const first = await recoverUnclaimedOrders(fetcher);
      expect(first.recovered).toEqual([order.id]);

      const second = await recoverUnclaimedOrders(fetcher);
      expect(second.recovered).toEqual([]);
      expect(second.filed).toEqual([]);

      const payments = await query(`SELECT 1 FROM payments WHERE order_id = $1`, [order.id]);
      expect(payments).toHaveLength(1);
      const consumed = await query(`SELECT 1 FROM consumed_signatures WHERE signature = $1`, [signature]);
      expect(consumed).toHaveLength(1);
    },
  );

  it(
    "ignores a signature already consumed by another order",
    { timeout: 20_000 },
    async () => {
      const w = await war();
      const otherTokenId = await insertToken({ warId: w.id, colourSlot: 1, status: "reserved" });
      const otherOrder = await expiredOrder({ warId: w.id, warTokenId: otherTokenId });
      const signature = randomSignature();
      // Simulate this exact signature already having settled a different
      // order (any prior claim — verified or not — burns it in
      // consumed_signatures; see settle.ts).
      await execute(
        `INSERT INTO consumed_signatures (signature, order_id, outcome, consumed_at)
         VALUES ($1, $2, 'verified', now())`,
        [signature, otherOrder.id],
      );

      const tokenId = await insertToken({ warId: w.id, colourSlot: 5, status: "released" });
      const order = await expiredOrder({ warId: w.id, warTokenId: tokenId });

      const result = await recoverUnclaimedOrders(
        mapFetcher(
          { [order.referencePubkey]: [signature] },
          { [signature]: fixtureTransaction({ amount: "25000000" }) },
        ),
      );

      expect(result.recovered).toEqual([]);
      expect(result.filed).toEqual([]);

      const refreshed = await orderById(order.id);
      expect(refreshed?.status).toBe("expired");
      const [tokenRow] = await query<{ status: string }>(`SELECT status FROM war_tokens WHERE id = $1`, [
        tokenId,
      ]);
      expect(tokenRow.status).toBe("released");
    },
  );

  it(
    "still rejects a candidate whose transaction predates the order's own createdAt — the window is widened forward only",
    { timeout: 20_000 },
    async () => {
      // A payment cannot predate the order whose reference it names, so
      // recovery does not widen the window backward: `outside_bid_window` is
      // the only possible verdict here and this candidate can never settle
      // this order. It is still put on the record, because the transfer did
      // credit our wallet with real USDC and money in our wallet with no
      // order to pay for is exactly what `unmatched_payments` is for — the
      // order itself stays expired, its colour stays released, and the
      // signature stays spendable for whatever it was really meant for.
      const w = await war();
      const tokenId = await insertToken({ warId: w.id, colourSlot: 5, status: "released" });
      const order = await expiredOrder({ warId: w.id, warTokenId: tokenId });
      const signature = randomSignature();

      const result = await recoverUnclaimedOrders(
        mapFetcher(
          { [order.referencePubkey]: [signature] },
          {
            [signature]: fixtureTransaction({
              amount: "25000000",
              blockTimeMs: order.createdAt.getTime() - 10 * 3_600_000,
            }),
          },
        ),
      );

      expect(result.recovered).toEqual([]);
      expect(result.filed).toEqual([order.id]);

      const refreshed = await orderById(order.id);
      expect(refreshed?.status).toBe("expired");
      const [tokenRow] = await query<{ status: string }>(`SELECT status FROM war_tokens WHERE id = $1`, [
        tokenId,
      ]);
      expect(tokenRow.status).toBe("released");

      const [unmatchedRow] = await query<{ reason: string; received_base_units: string }>(
        `SELECT reason, received_base_units FROM unmatched_payments WHERE order_id = $1`,
        [order.id],
      );
      expect(unmatchedRow).toMatchObject({
        reason: "outside_bid_window",
        received_base_units: "25000000",
      });
      const claimed = await query(`SELECT 1 FROM consumed_signatures WHERE signature = $1`, [signature]);
      expect(claimed).toHaveLength(0);
    },
  );

  it(
    "closes the outside_bid_window gap for a payment that landed after the order's window closed, the real late-confirmation case",
    { timeout: 20_000 },
    async () => {
      // Given the order's own real createdAt/expiresAt, `verifyPayment`
      // would reject this as `outside_bid_window` — a verdict settlePayment
      // can never file (see settle.ts's handleVerificationFailure). Recovery
      // widens the window forward (expiresAtMs: Date.now()), so the same
      // transaction now reaches the amount computation, and settlePayment
      // records it — here, filed rather than recovered, because it also
      // landed past LATE_CONFIRM_GRACE_MINUTES.
      const w = await war();
      const tokenId = await insertToken({ warId: w.id, colourSlot: 5, status: "released" });
      const order = await expiredOrder({ warId: w.id, warTokenId: tokenId, expiredMinutesAgo: 20 });
      const signature = randomSignature();
      const lateBlockTimeMs = order.expiresAt.getTime() + 5 * 60_000;

      const result = await recoverUnclaimedOrders(
        mapFetcher(
          { [order.referencePubkey]: [signature] },
          { [signature]: fixtureTransaction({ amount: "25000000", blockTimeMs: lateBlockTimeMs }) },
        ),
      );

      expect(result.recovered).toEqual([]);
      expect(result.filed).toEqual([order.id]);

      const refreshed = await orderById(order.id);
      expect(refreshed?.status).toBe("expired");
      const [unmatchedRow] = await query<{ reason: string }>(
        `SELECT reason FROM unmatched_payments WHERE order_id = $1`,
        [order.id],
      );
      expect(unmatchedRow.reason).toBe("late_confirm_past_grace");
    },
  );

  it(
    "settles the real payment even when an earlier candidate for the same order is filed first",
    { timeout: 20_000 },
    async () => {
      // Candidates are examined oldest first (see collectOldestCandidates),
      // and the real payment is always the OLDEST transaction naming a
      // reference — so the realistic way a filed verdict lands ahead of the
      // real one is the payer's own earlier, genuine attempt: an
      // underpayment, topped up moments later from the same wallet. Listed
      // here newest-first, exactly like the real RPC: the top-up first, the
      // original underpayment last (oldest).
      const w = await war();
      const tokenId = await insertToken({ warId: w.id, colourSlot: 5, status: "released" });
      const order = await expiredOrder({ warId: w.id, warTokenId: tokenId });
      const dustSignature = randomSignature();
      const realSignature = randomSignature();

      const result = await recoverUnclaimedOrders(
        mapFetcher(
          { [order.referencePubkey]: [realSignature, dustSignature] },
          {
            // Far under the order's price: insufficient_amount, filed, and —
            // per settle.ts — the signature is NOT consumed.
            [dustSignature]: fixtureTransaction({ amount: "1" }),
            [realSignature]: fixtureTransaction({ amount: "25000000" }),
          },
        ),
      );

      expect(result.recovered).toEqual([order.id]);
      expect(result.filed).toEqual([order.id]);

      const refreshed = await orderById(order.id);
      expect(refreshed?.status).toBe("paid");

      const [unmatchedRow] = await query<{ reason: string }>(
        `SELECT reason FROM unmatched_payments WHERE signature = $1`,
        [dustSignature],
      );
      expect(unmatchedRow.reason).toBe("insufficient_amount");

      const [paymentRow] = await query<{ signature: string }>(
        `SELECT signature FROM payments WHERE order_id = $1`,
        [order.id],
      );
      expect(paymentRow.signature).toBe(realSignature);
    },
  );

  it(
    "a poisoned candidate does not block the same order from being recovered on a later pass",
    { timeout: 20_000 },
    async () => {
      const w = await war();
      const tokenId = await insertToken({ warId: w.id, colourSlot: 5, status: "released" });
      const order = await expiredOrder({ warId: w.id, warTokenId: tokenId });
      const dustSignature = randomSignature();
      const realSignature = randomSignature();

      // Pass 1: only the junk candidate exists yet. It gets filed, and
      // nothing settles.
      const first = await recoverUnclaimedOrders(
        mapFetcher(
          { [order.referencePubkey]: [dustSignature] },
          { [dustSignature]: fixtureTransaction({ amount: "1" }) },
        ),
      );
      expect(first.recovered).toEqual([]);
      expect(first.filed).toEqual([order.id]);
      expect((await orderById(order.id))?.status).toBe("expired");

      // Pass 2: the real payment has since landed too. The order the first
      // pass could only file is fully recoverable on this one — nothing
      // about being filed once left it permanently blocked.
      const second = await recoverUnclaimedOrders(
        mapFetcher(
          { [order.referencePubkey]: [dustSignature, realSignature] },
          {
            [dustSignature]: fixtureTransaction({ amount: "1" }),
            [realSignature]: fixtureTransaction({ amount: "25000000" }),
          },
        ),
      );
      expect(second.recovered).toEqual([order.id]);

      const refreshed = await orderById(order.id);
      expect(refreshed?.status).toBe("paid");
    },
  );

  it(
    "caps a pass at MAX_ORDERS_PER_PASS candidates",
    { timeout: 20_000 },
    async () => {
      // 21 candidates, none of them resolvable — this test is purely about
      // how many of the 21 one pass examines (and therefore stamps), not
      // about settlement, so it tests the cap directly rather than through
      // the side effect of orders leaving the candidate set once paid. "The
      // deferred ones are reachable on the next pass" is proven better, and
      // already, by the starvation test below.
      // One combined statement per order (token + order together, via a
      // CTE) rather than the usual two-helper-calls-plus-a-readback shape:
      // this test's own setup cost is otherwise the dominant part of its
      // 20s budget, on top of the pass itself examining 20 real candidates.
      const w = await war({ maxTokens: 24 });
      const orderIds: string[] = [];
      for (let i = 0; i < 21; i++) {
        const tokenId = randomUUID();
        const orderId = randomUUID();
        await execute(
          `WITH new_token AS (
             INSERT INTO war_tokens
               (id, war_id, chain_id, contract, contract_key, colour_slot, status,
                name, ticker, metadata_fetched_at, reserved_at, released_at, released_reason)
             VALUES ($1, $2, 'solana', $1, $3, $4, 'released', 'Fixture', 'FIX', now(), now(),
                     now(), 'order_expired')
             RETURNING id
           )
           INSERT INTO entry_orders
             (id, war_id, war_token_id, amount_usd, payer_pubkey, reference_pubkey, status,
              created_at, expires_at)
           SELECT $5, $2, new_token.id, 25, NULL, $6, 'expired',
                  now() - interval '1 hour', now() - interval '2 minutes'
             FROM new_token`,
          [tokenId, w.id, randomUUID(), i + 1, orderId, randomUUID()],
        );
        orderIds.push(orderId);
      }

      await recoverUnclaimedOrders(mapFetcher({}, {}));

      const stamped = await query<{ id: string }>(
        `SELECT id FROM entry_orders WHERE id = ANY($1::text[]) AND recovery_attempted_at IS NOT NULL`,
        [orderIds],
      );
      expect(stamped).toHaveLength(20);
    },
  );

  it(
    "a poisoned order among the candidates does not starve a real, resolvable order out of a pass forever",
    // 21 orders created, same reasoning as the MAX_ORDERS_PER_PASS test above.
    { timeout: 60_000 },
    async () => {
      const w = await war({ maxTokens: 24 });

      // A poisoned order: one junk candidate, filed on every pass that
      // examines it, never resolved.
      const poisonToken = await insertToken({ warId: w.id, colourSlot: 1, status: "released" });
      const poisoned = await expiredOrder({ warId: w.id, warTokenId: poisonToken, expiredMinutesAgo: 2 });
      const dustSignature = randomSignature();

      // 19 filler orders with nothing at all to find — a realistic backlog
      // of ordinary abandoned reservations.
      const fillers = await manyResolvableOrders(w, 19, 2, () => 2);
      const fillerSignatures: Record<string, string[]> = {};
      for (const order of fillers.orders) fillerSignatures[order.referencePubkey] = [];

      // The one real order — expired slightly earlier than the poisoned
      // order and the fillers, so `expires_at DESC` sorts it last among an
      // otherwise-tied field of 21 and MAX_ORDERS_PER_PASS (20) excludes it
      // from the first pass.
      const targetToken = await insertToken({ warId: w.id, colourSlot: 21, status: "released" });
      const target = await expiredOrder({ warId: w.id, warTokenId: targetToken, expiredMinutesAgo: 3 });
      const realSignature = randomSignature();

      const fetcher = mapFetcher(
        {
          [poisoned.referencePubkey]: [dustSignature],
          ...fillerSignatures,
          [target.referencePubkey]: [realSignature],
        },
        {
          [dustSignature]: fixtureTransaction({ amount: "1" }),
          [realSignature]: fixtureTransaction({ amount: "25000000" }),
        },
      );

      const first = await recoverUnclaimedOrders(fetcher);
      expect(first.filed).toEqual([poisoned.id]);
      expect(first.recovered).toEqual([]);
      // The cap left the target out of this pass entirely.
      expect((await orderById(target.id))?.status).toBe("expired");

      // Every examined order — the poisoned one and all 19 fillers — is now
      // stamped, so the never-examined target sorts first on the next pass
      // and gets its turn instead of being crowded out again.
      const second = await recoverUnclaimedOrders(fetcher);
      expect(second.recovered).toEqual([target.id]);
    },
  );

  it(
    "a throwing signatures fetcher aborts the pass but leaves already-committed settlements intact",
    { timeout: 20_000 },
    async () => {
      const w = await war();
      const tokenA = await insertToken({ warId: w.id, colourSlot: 1, status: "released" });
      // Expired more recently than orderB, so expires_at DESC processes it
      // first.
      const orderA = await expiredOrder({ warId: w.id, warTokenId: tokenA, expiredMinutesAgo: 2 });
      const tokenB = await insertToken({ warId: w.id, colourSlot: 2, status: "released" });
      const orderB = await expiredOrder({ warId: w.id, warTokenId: tokenB, expiredMinutesAgo: 3 });

      const sigA = randomSignature();
      const boom = new Error("RPC exploded");

      const fetcher: RecoveryFetcher = {
        signatures: async (reference) => {
          if (reference === orderA.referencePubkey) return [{ signature: sigA, blockTime: null }];
          if (reference === orderB.referencePubkey) throw boom;
          return [];
        },
        transaction: async () => fixtureTransaction({ amount: "25000000" }),
      };

      await expect(recoverUnclaimedOrders(fetcher)).rejects.toThrow("RPC exploded");

      // orderA settled, and its progress marker was written, before the
      // throw on orderB ever happened.
      const refreshedA = await orderById(orderA.id);
      expect(refreshedA?.status).toBe("paid");
      const [rowA] = await query<{ recovery_attempted_at: Date | null }>(
        `SELECT recovery_attempted_at FROM entry_orders WHERE id = $1`,
        [orderA.id],
      );
      expect(rowA.recovery_attempted_at).toBeTruthy();

      // orderB WAS reached — its own signature fetch is exactly what threw
      // — so nothing about it settled or was filed, but the `finally` block
      // still stamps it: without that, orderB would keep
      // recovery_attempted_at NULL forever, sort ahead of every other
      // candidate on every future pass, and the pass would walk into it and
      // die again each time. See the re-review's N1.
      const [rowB] = await query<{ recovery_attempted_at: Date | null; status: string }>(
        `SELECT recovery_attempted_at, status FROM entry_orders WHERE id = $1`,
        [orderB.id],
      );
      expect(rowB.status).toBe("expired");
      expect(rowB.recovery_attempted_at).toBeTruthy();
    },
  );

  it(
    "files a payment against an order older than RECOVERY_MAX_AGE_DAYS, and seats nothing",
    { timeout: 20_000 },
    async () => {
      // The age bound bounds the COLOUR and nothing else. This test asserted
      // the opposite until this task: it required that an over-age order was
      // never examined, never stamped and never filed, which meant real money
      // in our wallet with no row in any table and no way for anybody to see
      // it. Past the bound the pass now verifies against the order's OWN
      // window, so the verdict is `outside_bid_window` — filed, with the
      // chain's own sender on the row for /admin/orphans to show, and no seat
      // taken.
      const w = await war();
      const tokenId = await insertToken({ warId: w.id, colourSlot: 5, status: "released" });
      const order = await expiredOrder({
        warId: w.id,
        warTokenId: tokenId,
        expiredMinutesAgo: 8 * 24 * 60, // 8 days — past the 7-day age bound
        createdMinutesAgo: 8 * 24 * 60 + 40,
      });
      const signature = randomSignature();

      const result = await recoverUnclaimedOrders(
        mapFetcher(
          { [order.referencePubkey]: [signature] },
          {
            [signature]: fixtureTransaction({
              amount: "25000000",
              payer: "9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin",
              // Ten minutes after the order's own window closed — past
              // BLOCKTIME_SKEW_SECONDS, so genuinely outside it. The ordinary
              // late transfer, and the whole case this bound used to lose.
              blockTimeMs: order.expiresAt.getTime() + 10 * 60_000,
            }),
          },
        ),
      );

      expect(result.recovered).toEqual([]);
      expect(result.filed).toEqual([order.id]);

      const [row] = await query<{ recovery_attempted_at: Date | null; status: string }>(
        `SELECT recovery_attempted_at, status FROM entry_orders WHERE id = $1`,
        [order.id],
      );
      // Examined, stamped, and still expired: the order did not take a seat.
      expect(row.status).toBe("expired");
      expect(row.recovery_attempted_at).toBeTruthy();
      expect(await query(`SELECT status FROM war_tokens WHERE id = $1`, [tokenId])).toEqual([
        { status: "released" },
      ]);
      expect(await query(`SELECT id FROM payments WHERE order_id = $1`, [order.id])).toHaveLength(0);

      // The record a human can act on, which is the point of the change.
      expect(
        await query<{ reason: string; received_base_units: string; sender_fee_payer: string | null }>(
          `SELECT reason, received_base_units, sender_fee_payer, status
             FROM unmatched_payments WHERE order_id = $1`,
          [order.id],
        ),
      ).toEqual([
        {
          reason: "outside_bid_window",
          received_base_units: "25000000",
          sender_fee_payer: "9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin",
          status: "open",
        },
      ]);
    },
  );

  it(
    "files, and still seats nothing, when an over-age order's payment landed inside its own window",
    { timeout: 20_000 },
    async () => {
      // The other half of the bound. A transfer that DID land inside the
      // order's window verifies, so it reaches settlePayment — which is more
      // than seven days past LATE_CONFIRM_GRACE_MINUTES and can only file.
      // Both paths out of an over-age order end in a row a human can see, and
      // neither can flip a colour.
      const w = await war();
      const tokenId = await insertToken({ warId: w.id, colourSlot: 6, status: "released" });
      const order = await expiredOrder({
        warId: w.id,
        warTokenId: tokenId,
        expiredMinutesAgo: 9 * 24 * 60,
        createdMinutesAgo: 9 * 24 * 60 + 40,
      });
      const signature = randomSignature();

      const result = await recoverUnclaimedOrders(
        mapFetcher(
          { [order.referencePubkey]: [signature] },
          {
            [signature]: fixtureTransaction({
              amount: "25000000",
              blockTimeMs: order.expiresAt.getTime() - 10 * 60_000,
            }),
          },
        ),
      );

      expect(result.recovered).toEqual([]);
      expect(result.filed).toEqual([order.id]);
      expect(await query(`SELECT status FROM war_tokens WHERE id = $1`, [tokenId])).toEqual([
        { status: "released" },
      ]);
      expect(await query(`SELECT id FROM payments WHERE order_id = $1`, [order.id])).toHaveLength(0);
      expect(
        await query<{ reason: string }>(
          `SELECT reason FROM unmatched_payments WHERE order_id = $1`,
          [order.id],
        ),
      ).toEqual([{ reason: "late_confirm_past_grace" }]);
    },
  );

  it(
    "settles a real payment that arrived behind more than MAX_SIGNATURES_PER_REFERENCE newer dust transfers naming the same reference",
    { timeout: 20_000 },
    async () => {
      // getSignaturesForAddress is newest-first. Five dust transfers, all
      // necessarily sent after the real payment — a reference is public only
      // once the real transfer lands, so nothing can be sent naming it
      // earlier — would have crowded the real payment out of a fixed
      // newest-N window entirely, on every pass, forever. Recovery pages
      // backward and keeps the OLDEST candidates instead, so the real
      // payment survives.
      const w = await war();
      const tokenId = await insertToken({ warId: w.id, colourSlot: 5, status: "released" });
      const order = await expiredOrder({ warId: w.id, warTokenId: tokenId });
      const realSignature = randomSignature();
      const dustSignatures = Array.from({ length: 5 }, () => randomSignature());

      const transactionsBySignature: Record<string, SolanaTransaction> = {
        [realSignature]: fixtureTransaction({ amount: "25000000" }),
      };
      for (const dust of dustSignatures) {
        transactionsBySignature[dust] = fixtureTransaction({ amount: "1" });
      }

      const result = await recoverUnclaimedOrders(
        mapFetcher(
          // Newest first, exactly like the real RPC: five dust, then the
          // real payment last — the oldest.
          { [order.referencePubkey]: [...dustSignatures, realSignature] },
          transactionsBySignature,
        ),
      );

      expect(result.recovered).toEqual([order.id]);
      const [paymentRow] = await query<{ signature: string }>(
        `SELECT signature FROM payments WHERE order_id = $1`,
        [order.id],
      );
      expect(paymentRow.signature).toBe(realSignature);
    },
  );

  it(
    "pages backward with `before` across multiple calls, and still finds the real payment several pages behind fresher dust",
    { timeout: 20_000 },
    async () => {
      const w = await war();
      const tokenId = await insertToken({ warId: w.id, colourSlot: 5, status: "released" });
      const order = await expiredOrder({ warId: w.id, warTokenId: tokenId });
      const realSignature = randomSignature();

      // Three full pages (SIGNATURE_PAGE_SIZE = 25 each, so none of them
      // alone stops the paging) of dust, then a short fourth page holding
      // only the real payment — proving collectOldestCandidates genuinely
      // chains `before` across calls rather than only ever looking at the
      // first page. The dust signatures never need transaction fixtures:
      // only the oldest 5 collected candidates are ever verified, and the
      // real payment — fetched last, so oldest once reversed — is always
      // first among those.
      const fullPage = () => Array.from({ length: 25 }, () => randomSignature());
      const pages = [fullPage(), fullPage(), fullPage(), [realSignature]];
      const beforeSeen: (string | undefined)[] = [];

      const fetcher: RecoveryFetcher = {
        signatures: async (reference, before) => {
          expect(reference).toBe(order.referencePubkey);
          beforeSeen.push(before);
          const page = pages[beforeSeen.length - 1] ?? [];
          return page.map((signature) => ({ signature, blockTime: null }));
        },
        transaction: async (signature) =>
          signature === realSignature ? fixtureTransaction({ amount: "25000000" }) : null,
      };

      const result = await recoverUnclaimedOrders(fetcher);

      expect(result.recovered).toEqual([order.id]);
      expect(beforeSeen).toEqual([
        undefined,
        pages[0][pages[0].length - 1],
        pages[1][pages[1].length - 1],
        pages[2][pages[2].length - 1],
      ]);
    },
  );

  it(
    "logs and still examines what it found when the page ceiling is reached without ever finding the order's own createdAt",
    { timeout: 20_000 },
    async () => {
      const w = await war();
      const tokenId = await insertToken({ warId: w.id, colourSlot: 5, status: "released" });
      const order = await expiredOrder({ warId: w.id, warTokenId: tokenId });

      // Four full pages — SIGNATURE_PAGE_CEILING pages of SIGNATURE_PAGE_SIZE
      // each, 100 signatures total — none of them short, none reaching the
      // order's own createdAt: a flood, not ordinary usage.
      const fullPage = () => Array.from({ length: 25 }, () => randomSignature());
      const pages = [fullPage(), fullPage(), fullPage(), fullPage()];
      const transactionsBySignature: Record<string, SolanaTransaction> = {};
      for (const page of pages) {
        for (const signature of page) {
          transactionsBySignature[signature] = fixtureTransaction({ amount: "1" });
        }
      }

      let call = 0;
      const fetcher: RecoveryFetcher = {
        signatures: async () => {
          const page = pages[call] ?? [];
          call += 1;
          return page.map((signature) => ({ signature, blockTime: null }));
        },
        transaction: async (signature) => transactionsBySignature[signature] ?? null,
      };

      const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      try {
        const result = await recoverUnclaimedOrders(fetcher);

        // Nothing settles (every examined candidate is dust), but the search
        // did not just give up: the oldest MAX_SIGNATURES_PER_REFERENCE of
        // what was found are still tried and filed.
        expect(result.recovered).toEqual([]);
        expect(result.filed).toEqual([order.id]);

        const floodLog = errorSpy.mock.calls.find(
          (call) => typeof call[0] === "string" && call[0].includes(order.id),
        );
        expect(floodLog).toBeDefined();
        expect(String(floodLog?.[0])).toMatch(/100/);

        const [row] = await query<{ recovery_attempted_at: Date | null }>(
          `SELECT recovery_attempted_at FROM entry_orders WHERE id = $1`,
          [order.id],
        );
        expect(row.recovery_attempted_at).toBeTruthy();
      } finally {
        errorSpy.mockRestore();
      }
    },
  );
});

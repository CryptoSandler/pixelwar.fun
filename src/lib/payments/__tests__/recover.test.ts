import { randomBytes, randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { base58Encode } from "../../base58";
import { execute, query, queryOne } from "../../db";
import type { War } from "../../wars/lifecycle";
import { USDC_MINT } from "../config";
import { orderById } from "../orders";
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
}) {
  const id = randomUUID();
  await execute(
    `INSERT INTO entry_orders
       (id, war_id, war_token_id, amount_usd, payer_pubkey, reference_pubkey, status,
        created_at, expires_at)
     VALUES ($1, $2, $3, $4, $5, $6, 'expired', now() - interval '1 hour', $7)`,
    [
      id,
      overrides.warId,
      overrides.warTokenId,
      overrides.amountUsd ?? 25,
      overrides.payerPubkey ?? null,
      overrides.referencePubkey ?? randomUUID(),
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

/** Builds a fetcher from plain maps: reference -> its signatures, signature -> its transaction. */
function mapFetcher(
  signaturesByReference: Record<string, string[]>,
  transactionsBySignature: Record<string, SolanaTransaction>,
): RecoveryFetcher {
  return {
    signatures: async (reference) => signaturesByReference[reference] ?? [],
    transaction: async (signature) => transactionsBySignature[signature] ?? null,
  };
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
    "closes the outside_bid_window gap: a payment found by reference settles even though it landed off the order's original window",
    { timeout: 20_000 },
    async () => {
      // `verifyPayment` alone, given this order's real createdAt/expiresAt,
      // would report `outside_bid_window` for a transaction this old — and
      // settlePayment cannot file that verdict (see settle.ts's own comment
      // on handleVerificationFailure). Recovery finds this signature by
      // reference, not by a submitted string, so it is not bound by that
      // window the same way — see the doc comment on recoverUnclaimedOrders.
      // Within LATE_CONFIRM_GRACE_MINUTES of its own expiry, so the only
      // thing under test is the block-time window, not the grace period.
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
              // Ten hours before the order even existed — well outside any
              // window /confirm would ever have accepted.
              blockTimeMs: order.createdAt.getTime() - 10 * 3_600_000,
            }),
          },
        ),
      );

      expect(result.recovered).toEqual([order.id]);
      const refreshed = await orderById(order.id);
      expect(refreshed?.status).toBe("paid");
    },
  );
});

import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { execute, query, queryOne } from "../../db";
import type { War } from "../../wars/lifecycle";
import { orderById } from "../orders";
import { recordVerificationAttempt, settlePayment, verifyRateLimited } from "../settle";
import type { PaymentFailure, VerifyResult } from "../solana";

/**
 * Settlement: where a verified payment becomes a paid order and an active
 * token. Every test here proves either the atomic success (payment + order
 * + token, together, or none of them) or that a specific race the schema is
 * built to survive really does resolve the way the brief describes.
 *
 * `verified` is built by hand rather than produced by `verifyPayment`: the
 * RPC round trip is solana.ts's concern (see verifier.test.ts), already
 * proven there. Settlement starts from the verdict, not the network call.
 */

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

async function insertOrder(overrides: {
  warId: string;
  warTokenId: string;
  status?: "pending" | "paid" | "expired" | "failed";
  amountUsd?: number;
  payerPubkey?: string | null;
  expiresAt?: Date;
  referencePubkey?: string;
}) {
  const id = randomUUID();
  await execute(
    `INSERT INTO entry_orders
       (id, war_id, war_token_id, amount_usd, payer_pubkey, reference_pubkey, status,
        created_at, expires_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, now() - interval '20 minutes', $8)`,
    [
      id,
      overrides.warId,
      overrides.warTokenId,
      overrides.amountUsd ?? 25,
      overrides.payerPubkey ?? null,
      overrides.referencePubkey ?? randomUUID(),
      overrides.status ?? "pending",
      overrides.expiresAt ?? new Date(Date.now() + 10 * 60_000),
    ],
  );
  return (await orderById(id))!;
}

const okVerified = (amountBaseUnits: bigint): VerifyResult => ({ ok: true, amountBaseUnits });
const failVerified = (reason: PaymentFailure, message = "verification failed"): VerifyResult => ({
  ok: false,
  reason,
  message,
});

describe("settlePayment: the normal path", () => {
  it(
    "marks the order paid and the token active",
    { timeout: 20_000 },
    async () => {
      const w = await war();
      const tokenId = await insertToken({ warId: w.id, colourSlot: 5, status: "reserved" });
      const order = await insertOrder({ warId: w.id, warTokenId: tokenId, amountUsd: 25 });
      const signature = randomUUID();

      const result = await settlePayment({
        order,
        signature,
        verified: okVerified(25_000_000n),
      });

      expect(result).toEqual({ ok: true, amountBaseUnits: 25_000_000n });

      const refreshed = await orderById(order.id);
      expect(refreshed?.status).toBe("paid");
      expect(refreshed?.paidAt).toBeTruthy();

      const [tokenRow] = await query<{ status: string; joined_at: Date | null }>(
        `SELECT status, joined_at FROM war_tokens WHERE id = $1`,
        [tokenId],
      );
      expect(tokenRow.status).toBe("active");
      expect(tokenRow.joined_at).toBeTruthy();

      const [paymentRow] = await query<{ signature: string; amount_base_units: string; order_id: string }>(
        `SELECT signature, amount_base_units, order_id FROM payments WHERE order_id = $1`,
        [order.id],
      );
      expect(paymentRow).toMatchObject({ signature, amount_base_units: "25000000", order_id: order.id });

      const [consumedRow] = await query<{ outcome: string; order_id: string }>(
        `SELECT outcome, order_id FROM consumed_signatures WHERE signature = $1`,
        [signature],
      );
      expect(consumedRow).toMatchObject({ outcome: "verified", order_id: order.id });
    },
  );

  it(
    "accepts an overpayment and records what arrived",
    { timeout: 20_000 },
    async () => {
      const w = await war();
      const tokenId = await insertToken({ warId: w.id, colourSlot: 5, status: "reserved" });
      const order = await insertOrder({ warId: w.id, warTokenId: tokenId, amountUsd: 25 });

      const result = await settlePayment({
        order,
        signature: randomUUID(),
        verified: okVerified(30_000_000n),
      });

      expect(result).toEqual({ ok: true, amountBaseUnits: 30_000_000n });

      const [paymentRow] = await query<{ amount_base_units: string }>(
        `SELECT amount_base_units FROM payments WHERE order_id = $1`,
        [order.id],
      );
      expect(paymentRow.amount_base_units).toBe("30000000");
    },
  );
});

describe("settlePayment: verification failure", () => {
  it(
    "leaves nothing behind when verification fails",
    { timeout: 20_000 },
    async () => {
      const w = await war();
      const tokenId = await insertToken({ warId: w.id, colourSlot: 5, status: "reserved" });
      const order = await insertOrder({ warId: w.id, warTokenId: tokenId });
      const signature = randomUUID();

      const result = await settlePayment({
        order,
        signature,
        verified: failVerified("insufficient_amount", "That transaction did not send enough."),
      });

      expect(result).toEqual({
        ok: false,
        reason: "insufficient_amount",
        message: "That transaction did not send enough.",
      });

      // The trio a real settlement would touch: none of it moved.
      const refreshed = await orderById(order.id);
      expect(refreshed?.status).toBe("pending");
      const [tokenRow] = await query<{ status: string }>(`SELECT status FROM war_tokens WHERE id = $1`, [
        tokenId,
      ]);
      expect(tokenRow.status).toBe("reserved");
      const payments = await query(`SELECT 1 FROM payments WHERE order_id = $1`, [order.id]);
      expect(payments).toHaveLength(0);
      const unmatched = await query(`SELECT 1 FROM unmatched_payments WHERE order_id = $1`, [order.id]);
      expect(unmatched).toHaveLength(0);

      // What IS left behind, deliberately: the signature is claimed, so it
      // cannot be tried again here or against a different order.
      const [consumedRow] = await query<{ outcome: string }>(
        `SELECT outcome FROM consumed_signatures WHERE signature = $1`,
        [signature],
      );
      expect(consumedRow.outcome).toBe("insufficient_amount");
    },
  );

  it(
    "refuses when the payer is not the order's wallet",
    { timeout: 20_000 },
    async () => {
      const w = await war();
      const tokenId = await insertToken({ warId: w.id, colourSlot: 5, status: "reserved" });
      const order = await insertOrder({
        warId: w.id,
        warTokenId: tokenId,
        payerPubkey: "ExpectedPayerWalletAddress11111111111111111",
      });

      const result = await settlePayment({
        order,
        signature: randomUUID(),
        verified: failVerified("wrong_payer", "That transaction was not paid from the wallet this order was opened with."),
      });

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.reason).toBe("wrong_payer");

      const refreshed = await orderById(order.id);
      expect(refreshed?.status).toBe("pending");
    },
  );
});

describe("settlePayment: the replay", () => {
  it(
    "refuses a signature already consumed by another order",
    { timeout: 20_000 },
    async () => {
      const w = await war();
      const tokenA = await insertToken({ warId: w.id, colourSlot: 1, status: "reserved" });
      const tokenB = await insertToken({ warId: w.id, colourSlot: 2, status: "reserved" });
      const orderA = await insertOrder({ warId: w.id, warTokenId: tokenA });
      const orderB = await insertOrder({ warId: w.id, warTokenId: tokenB });
      const signature = randomUUID();

      const first = await settlePayment({ order: orderA, signature, verified: okVerified(25_000_000n) });
      expect(first.ok).toBe(true);

      // A stranger takes orderA's already-spent signature and tries it
      // against a completely different order.
      const second = await settlePayment({ order: orderB, signature, verified: okVerified(25_000_000n) });

      expect(second).toEqual({
        ok: false,
        reason: "signature_reused",
        message: "That transaction signature has already been used.",
      });

      const refreshedB = await orderById(orderB.id);
      expect(refreshedB?.status).toBe("pending");
      const [tokenBRow] = await query<{ status: string }>(`SELECT status FROM war_tokens WHERE id = $1`, [
        tokenB,
      ]);
      expect(tokenBRow.status).toBe("reserved");
    },
  );

  it(
    "refuses a replay even when the first attempt failed verification",
    { timeout: 20_000 },
    async () => {
      // The reason consumed_signatures records failures too: a signature
      // that failed against one order must not be handed a second try
      // against a different one.
      const w = await war();
      const tokenA = await insertToken({ warId: w.id, colourSlot: 1, status: "reserved" });
      const tokenB = await insertToken({ warId: w.id, colourSlot: 2, status: "reserved" });
      const orderA = await insertOrder({ warId: w.id, warTokenId: tokenA });
      const orderB = await insertOrder({ warId: w.id, warTokenId: tokenB });
      const signature = randomUUID();

      const first = await settlePayment({
        order: orderA,
        signature,
        verified: failVerified("wrong_destination", "wrong wallet"),
      });
      expect(first.ok).toBe(false);

      const second = await settlePayment({ order: orderB, signature, verified: okVerified(25_000_000n) });

      expect(second).toEqual({
        ok: false,
        reason: "signature_reused",
        message: "That transaction signature has already been used.",
      });
    },
  );
});

describe("settlePayment: a second confirm of the same order", () => {
  it(
    "refuses a second confirm of the same order",
    { timeout: 20_000 },
    async () => {
      const w = await war();
      const tokenId = await insertToken({ warId: w.id, colourSlot: 5, status: "reserved" });
      const order = await insertOrder({
        warId: w.id,
        warTokenId: tokenId,
        payerPubkey: "PayerWalletAddress111111111111111111111111",
      });

      const first = await settlePayment({
        order,
        signature: randomUUID(),
        verified: okVerified(25_000_000n),
      });
      expect(first.ok).toBe(true);

      // A second, independently valid payment for the same order — the
      // money is real, but there is nowhere left for it to settle.
      const second = await settlePayment({
        order,
        signature: randomUUID(),
        verified: okVerified(25_000_000n),
      });

      expect(second.ok).toBe(false);
      if (second.ok) return;
      expect(second.reason).toBe("already_settled");
      expect(second.supportContact).toBeDefined();

      const payments = await query(`SELECT 1 FROM payments WHERE order_id = $1`, [order.id]);
      expect(payments).toHaveLength(1);

      const [unmatchedRow] = await query<{ reason: string; sender_fee_payer: string | null }>(
        `SELECT reason, sender_fee_payer FROM unmatched_payments WHERE order_id = $1`,
        [order.id],
      );
      expect(unmatchedRow).toMatchObject({
        reason: "order_already_paid",
        sender_fee_payer: "PayerWalletAddress111111111111111111111111",
      });
    },
  );

  it(
    "lets exactly one of two simultaneous valid payments settle the same order",
    { timeout: 20_000 },
    async () => {
      // Not a signature race (that is the replay tests above) — two
      // genuinely different, independently valid transfers landing for the
      // same order at the same instant. The FOR UPDATE lock on the order row
      // is what has to arbitrate this, since payments_order_unique alone
      // would leave one caller mid-flip with no order left to attach to.
      const w = await war();
      const tokenId = await insertToken({ warId: w.id, colourSlot: 5, status: "reserved" });
      const order = await insertOrder({ warId: w.id, warTokenId: tokenId });

      const [a, b] = await Promise.all([
        settlePayment({ order, signature: randomUUID(), verified: okVerified(25_000_000n) }),
        settlePayment({ order, signature: randomUUID(), verified: okVerified(25_000_000n) }),
      ]);

      const outcomes = [a, b];
      const winners = outcomes.filter((r) => r.ok);
      const losers = outcomes.filter((r) => !r.ok);
      expect(winners).toHaveLength(1);
      expect(losers).toHaveLength(1);
      expect((losers[0] as { reason: string }).reason).toBe("already_settled");

      const refreshed = await orderById(order.id);
      expect(refreshed?.status).toBe("paid");

      const payments = await query(`SELECT 1 FROM payments WHERE order_id = $1`, [order.id]);
      expect(payments).toHaveLength(1);
      const unmatched = await query(`SELECT 1 FROM unmatched_payments WHERE order_id = $1`, [order.id]);
      expect(unmatched).toHaveLength(1);
    },
  );
});

describe("settlePayment: late confirmation", () => {
  async function expiredReservation(overrides: {
    maxTokens?: number;
    colourSlot?: number;
    expiredMinutesAgo?: number;
  } = {}) {
    const w = await war({ maxTokens: overrides.maxTokens ?? 24 });
    const tokenId = await insertToken({
      warId: w.id,
      colourSlot: overrides.colourSlot ?? 5,
      status: "released",
    });
    const order = await insertOrder({
      warId: w.id,
      warTokenId: tokenId,
      expiresAt: new Date(Date.now() - (overrides.expiredMinutesAgo ?? 2) * 60_000),
    });
    await execute(`UPDATE entry_orders SET status = 'expired' WHERE id = $1`, [order.id]);
    return { war: w, tokenId, order: (await orderById(order.id))! };
  }

  it(
    "re-takes the same colour on a late confirm when it is still free",
    { timeout: 20_000 },
    async () => {
      const { tokenId, order } = await expiredReservation();

      const result = await settlePayment({
        order,
        signature: randomUUID(),
        verified: okVerified(25_000_000n),
      });

      expect(result.ok).toBe(true);

      const refreshed = await orderById(order.id);
      expect(refreshed?.status).toBe("paid");

      const [tokenRow] = await query<{ status: string; released_at: Date | null }>(
        `SELECT status, released_at FROM war_tokens WHERE id = $1`,
        [tokenId],
      );
      expect(tokenRow).toMatchObject({ status: "active", released_at: null });
    },
  );

  it(
    "offers the remaining colours when the colour was taken meanwhile",
    { timeout: 20_000 },
    async () => {
      const { war: w, order } = await expiredReservation({ maxTokens: 3, colourSlot: 2 });
      // Someone else took colour 2 in the meantime, with a fresh reservation.
      await insertToken({ warId: w.id, colourSlot: 2, status: "active" });

      const result = await settlePayment({
        order,
        signature: randomUUID(),
        verified: okVerified(25_000_000n),
      });

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.reason).toBe("unmatched");
      expect(result.freeColours?.sort()).toEqual([1, 3]);
      expect(result.supportContact).toBeDefined();

      const refreshed = await orderById(order.id);
      expect(refreshed?.status).toBe("expired");

      const [unmatchedRow] = await query<{ reason: string }>(
        `SELECT reason FROM unmatched_payments WHERE order_id = $1`,
        [order.id],
      );
      expect(unmatchedRow.reason).toBe("colour_taken");
    },
  );

  it(
    "files a payment that arrived after the war filled up",
    { timeout: 20_000 },
    async () => {
      const { war: w, order } = await expiredReservation({ maxTokens: 1, colourSlot: 1 });
      // The war's one seat has since gone to a different colour entirely —
      // this order's own colour (1) is not the one in conflict, capacity is.
      await insertToken({ warId: w.id, colourSlot: 2, status: "active" });

      const result = await settlePayment({
        order,
        signature: randomUUID(),
        verified: okVerified(25_000_000n),
      });

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.reason).toBe("unmatched");

      const [unmatchedRow] = await query<{ reason: string; received_base_units: string }>(
        `SELECT reason, received_base_units FROM unmatched_payments WHERE order_id = $1`,
        [order.id],
      );
      expect(unmatchedRow).toMatchObject({ reason: "war_full", received_base_units: "25000000" });
    },
  );

  it(
    "files a payment that arrives once the war has ended",
    { timeout: 20_000 },
    async () => {
      const { order } = await expiredReservation();
      await execute(
        `UPDATE wars SET status = 'ended', ended_at = now() WHERE id = $1`,
        [order.warId],
      );

      const result = await settlePayment({
        order,
        signature: randomUUID(),
        verified: okVerified(25_000_000n),
      });

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.reason).toBe("unmatched");
      expect(result.freeColours).toEqual([]);

      const [unmatchedRow] = await query<{ reason: string }>(
        `SELECT reason FROM unmatched_payments WHERE order_id = $1`,
        [order.id],
      );
      expect(unmatchedRow.reason).toBe("war_closed");
    },
  );

  it(
    "goes straight to unmatched once the grace period has passed, without touching the colour",
    { timeout: 20_000 },
    async () => {
      const { tokenId, order } = await expiredReservation({ expiredMinutesAgo: 120 });

      const result = await settlePayment({
        order,
        signature: randomUUID(),
        verified: okVerified(25_000_000n),
      });

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.reason).toBe("unmatched");

      // The colour was never touched: still released, free for anyone.
      const [tokenRow] = await query<{ status: string }>(`SELECT status FROM war_tokens WHERE id = $1`, [
        tokenId,
      ]);
      expect(tokenRow.status).toBe("released");

      const [unmatchedRow] = await query<{ reason: string }>(
        `SELECT reason FROM unmatched_payments WHERE order_id = $1`,
        [order.id],
      );
      expect(unmatchedRow.reason).toBe("late_confirm_past_grace");
    },
  );
});

describe("verification rate limiting", () => {
  it(
    "rate limits repeated verification attempts against the same order",
    { timeout: 20_000 },
    async () => {
      const w = await war();
      const tokenId = await insertToken({ warId: w.id, colourSlot: 5, status: "reserved" });
      const order = await insertOrder({ warId: w.id, warTokenId: tokenId });

      // 10 attempts well outside the minimum-interval window, so only the
      // per-order cap (10) is being exercised here.
      for (let i = 0; i < 10; i++) {
        await execute(
          `INSERT INTO verification_attempts (id, order_id, ip_hash, attempted_at)
           VALUES ($1, $2, 'ip-a', now() - interval '1 minute')`,
          [randomUUID(), order.id],
        );
      }

      const result = await verifyRateLimited(order.id, "ip-a");

      expect(result).toEqual({
        limited: true,
        message: "Too many verification attempts for this order recently. Wait a while and try again.",
      });
    },
  );

  it(
    "rate limits attempts made too close together, regardless of the per-order count",
    { timeout: 20_000 },
    async () => {
      const w = await war();
      const tokenId = await insertToken({ warId: w.id, colourSlot: 5, status: "reserved" });
      const order = await insertOrder({ warId: w.id, warTokenId: tokenId });

      await recordVerificationAttempt(order.id, "ip-a");

      const result = await verifyRateLimited(order.id, "ip-a");

      expect(result).toEqual({
        limited: true,
        message: "Checking again too quickly. Wait a moment and retry.",
      });
    },
  );

  it(
    "rate limits a caller hammering many different orders",
    { timeout: 20_000 },
    async () => {
      const w = await war();

      // 30 attempts spread across 30 different orders — the per-IP cap, not
      // the per-order cap, is what this is exercising.
      for (let i = 0; i < 30; i++) {
        await execute(
          `INSERT INTO verification_attempts (id, order_id, ip_hash, attempted_at)
           VALUES ($1, $2, 'ip-shared', now() - interval '1 minute')`,
          [randomUUID(), randomUUID()],
        );
      }

      const freshOrder = await insertOrder({
        warId: w.id,
        warTokenId: await insertToken({ warId: w.id, colourSlot: 10, status: "reserved" }),
      });

      const result = await verifyRateLimited(freshOrder.id, "ip-shared");

      expect(result).toEqual({
        limited: true,
        message: "Too many verification attempts from this address recently. Wait a while and try again.",
      });
    },
  );

  it(
    "allows a fresh order with no prior attempts",
    { timeout: 20_000 },
    async () => {
      const w = await war();
      const tokenId = await insertToken({ warId: w.id, colourSlot: 5, status: "reserved" });
      const order = await insertOrder({ warId: w.id, warTokenId: tokenId });

      const result = await verifyRateLimited(order.id, "ip-fresh");

      expect(result).toEqual({ limited: false });
    },
  );
});

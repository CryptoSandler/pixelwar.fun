import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { execute, query, queryOne } from "../../db";
import type { War } from "../../wars/lifecycle";
import { orderById } from "../orders";
import { recordVerificationAttempt, settlePayment, verifyRateLimited } from "../settle";
import type { PaymentFailure, SenderInfo, VerifyResult } from "../solana";

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
const failVerified = (
  reason: PaymentFailure,
  message = "verification failed",
  extra: { receivedBaseUnits?: bigint; sender?: SenderInfo; provenNotOurs?: boolean } = {},
): VerifyResult => ({ ok: false, reason, message, ...extra });

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
  /**
   * `consumed_signatures` was, in an earlier version of this code, claimed
   * for EVERY failure — including this one. That was wrong, and dangerously
   * so: `not_confirmed` is the ordinary, expected first answer on the normal
   * path (a wallet hands the browser its signature before the cluster
   * confirms it), and its own message tells the payer to retry. Claiming the
   * signature there meant the retry could only ever come back
   * `signature_reused`, with real USDC sitting in our wallet and nothing
   * crediting it. This is the regression test for that bug.
   */
  it(
    "a not_confirmed first attempt followed by a successful retry with the same signature settles",
    { timeout: 20_000 },
    async () => {
      const w = await war();
      const tokenId = await insertToken({ warId: w.id, colourSlot: 5, status: "reserved" });
      const order = await insertOrder({ warId: w.id, warTokenId: tokenId });
      const signature = randomUUID();

      const first = await settlePayment({
        order,
        signature,
        verified: failVerified("not_confirmed", "That transaction is not confirmed yet. Wait a few seconds and try again."),
      });
      expect(first).toEqual({
        ok: false,
        reason: "not_confirmed",
        message: "That transaction is not confirmed yet. Wait a few seconds and try again.",
      });

      // Nothing at all was left behind by the first attempt — not even a
      // consumed_signatures row — because the transaction may simply not
      // have landed on the cluster yet, and the SAME signature has to still
      // be usable once it does.
      const noClaim = await query(`SELECT 1 FROM consumed_signatures WHERE signature = $1`, [signature]);
      expect(noClaim).toHaveLength(0);

      // The cluster confirms it a moment later; the payer's client retries
      // with the exact same signature.
      const second = await settlePayment({ order, signature, verified: okVerified(25_000_000n) });

      expect(second).toEqual({ ok: true, amountBaseUnits: 25_000_000n });
      const refreshed = await orderById(order.id);
      expect(refreshed?.status).toBe("paid");
      const [tokenRow] = await query<{ status: string }>(`SELECT status FROM war_tokens WHERE id = $1`, [
        tokenId,
      ]);
      expect(tokenRow.status).toBe("active");
    },
  );

  it(
    "leaves nothing behind for every retryable verdict: rpc_unavailable, no_block_time, outside_bid_window, invalid_signature",
    { timeout: 20_000 },
    async () => {
      const w = await war();
      for (const reason of ["rpc_unavailable", "no_block_time", "outside_bid_window", "invalid_signature"] as const) {
        const tokenId = await insertToken({ warId: w.id, colourSlot: 5, status: "reserved" });
        const order = await insertOrder({ warId: w.id, warTokenId: tokenId });
        const signature = randomUUID();

        const result = await settlePayment({ order, signature, verified: failVerified(reason, `${reason} message`) });

        expect(result).toEqual({ ok: false, reason, message: `${reason} message` });
        const refreshed = await orderById(order.id);
        expect(refreshed?.status).toBe("pending");
        const claimed = await query(`SELECT 1 FROM consumed_signatures WHERE signature = $1`, [signature]);
        expect(claimed).toHaveLength(0);
        const unmatched = await query(`SELECT 1 FROM unmatched_payments WHERE signature = $1`, [signature]);
        expect(unmatched).toHaveLength(0);

        await execute(`UPDATE war_tokens SET status = 'released' WHERE id = $1`, [tokenId]);
      }
    },
  );

  it(
    "permanently claims a signature that could never pay any order: failed_tx, wrong_token, wrong_destination",
    { timeout: 20_000 },
    async () => {
      const w = await war();
      for (const reason of ["failed_tx", "wrong_token", "wrong_destination"] as const) {
        const tokenId = await insertToken({ warId: w.id, colourSlot: 5, status: "reserved" });
        const order = await insertOrder({ warId: w.id, warTokenId: tokenId });
        const signature = randomUUID();

        const result = await settlePayment({
          order,
          signature,
          // `provenNotOurs` is what makes the wrong_destination case belong
          // in this list at all: the RPC positively reported USDC moving,
          // attributed to an owner who is not us. The unsubstantiated case
          // is the test below, and it must NOT be claimed.
          verified: failVerified(reason, `${reason} message`, { provenNotOurs: true }),
        });

        expect(result).toEqual({ ok: false, reason, message: `${reason} message` });
        const [consumedRow] = await query<{ outcome: string }>(
          `SELECT outcome FROM consumed_signatures WHERE signature = $1`,
          [signature],
        );
        expect(consumedRow.outcome).toBe(reason);

        // A second attempt with the same signature, however it verifies,
        // cannot ever settle anything — the claim already fired.
        const replay = await settlePayment({ order, signature, verified: okVerified(25_000_000n) });
        expect(replay).toEqual({
          ok: false,
          reason: "signature_reused",
          message: "That transaction signature has already been used.",
        });

        await execute(`UPDATE war_tokens SET status = 'released' WHERE id = $1`, [tokenId]);
      }
    },
  );

  const CHAIN_SENDER: SenderInfo = { feePayer: "OnChainFeePayer1111111111111111111111111111", debited: [] };

  it(
    "refuses when the payer is not the order's wallet, and files the real payment with the sender the chain names",
    { timeout: 20_000 },
    async () => {
      const w = await war();
      const tokenId = await insertToken({ warId: w.id, colourSlot: 5, status: "reserved" });
      const order = await insertOrder({
        warId: w.id,
        warTokenId: tokenId,
        payerPubkey: "ExpectedPayerWalletAddress11111111111111111",
      });
      const signature = randomUUID();

      const result = await settlePayment({
        order,
        signature,
        verified: failVerified(
          "wrong_payer",
          "That transaction was not paid from the wallet this order was opened with.",
          { receivedBaseUnits: 25_000_000n, sender: CHAIN_SENDER },
        ),
      });

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.reason).toBe("wrong_payer");

      const refreshed = await orderById(order.id);
      expect(refreshed?.status).toBe("pending");

      // Real USDC reached our wallet; it is on record, with the sender the
      // chain reported — never the order's own asserted payerPubkey.
      const [unmatchedRow] = await query<{
        reason: string;
        received_base_units: string;
        sender_fee_payer: string | null;
      }>(
        `SELECT reason, received_base_units, sender_fee_payer FROM unmatched_payments WHERE signature = $1`,
        [signature],
      );
      expect(unmatchedRow).toMatchObject({
        reason: "wrong_payer",
        received_base_units: "25000000",
        sender_fee_payer: "OnChainFeePayer1111111111111111111111111111",
      });

      // And, unlike the never-payable reasons above, the signature itself
      // was NOT claimed — see the Critical 2 regression test below for why
      // that matters.
      const claimed = await query(`SELECT 1 FROM consumed_signatures WHERE signature = $1`, [signature]);
      expect(claimed).toHaveLength(0);
    },
  );

  it(
    "records real USDC that underpaid an order, without spending the signature, and does not duplicate the record on retry",
    { timeout: 20_000 },
    async () => {
      const w = await war();
      const tokenId = await insertToken({ warId: w.id, colourSlot: 5, status: "reserved" });
      const order = await insertOrder({ warId: w.id, warTokenId: tokenId, amountUsd: 25 });
      const signature = randomUUID();
      const verified = failVerified("insufficient_amount", "underpaid", {
        receivedBaseUnits: 10_000_000n,
        sender: CHAIN_SENDER,
      });

      await settlePayment({ order, signature, verified });
      await settlePayment({ order, signature, verified }); // same signature, retried

      const unmatchedRows = await query(`SELECT 1 FROM unmatched_payments WHERE signature = $1`, [signature]);
      expect(unmatchedRows).toHaveLength(1);
      const claimed = await query(`SELECT 1 FROM consumed_signatures WHERE signature = $1`, [signature]);
      expect(claimed).toHaveLength(0);
    },
  );

  /**
   * Critical 2: because the old code claimed a signature before it even
   * read which order it was up against, the claim succeeded no matter whose
   * order it was tried on. An attacker watching our wallet could take a
   * bystander's in-flight signature, post it against an order THEY control,
   * collect wrong_payer — and the signature was spent, permanently, before
   * its real owner ever got a turn. This proves the fix: a losing attempt
   * against the wrong order leaves the right order still able to settle it.
   */
  it(
    "a wrong_payer attempt against an attacker's order leaves the victim able to settle the same signature on theirs",
    { timeout: 20_000 },
    async () => {
      const w = await war();
      const victimTokenId = await insertToken({ warId: w.id, colourSlot: 5, status: "reserved" });
      const victimOrder = await insertOrder({
        warId: w.id,
        warTokenId: victimTokenId,
        payerPubkey: "VictimWalletAddress1111111111111111111111",
      });
      const attackerTokenId = await insertToken({ warId: w.id, colourSlot: 6, status: "reserved" });
      const attackerOrder = await insertOrder({
        warId: w.id,
        warTokenId: attackerTokenId,
        payerPubkey: "AttackerWalletAddress111111111111111111111",
      });
      // The victim's real, valid transaction signature.
      const signature = randomUUID();

      // The attacker posts it against their own order. Checked against
      // THEIR expected wallet, it comes back wrong_payer.
      const attackerAttempt = await settlePayment({
        order: attackerOrder,
        signature,
        verified: failVerified("wrong_payer", "wrong wallet", {
          receivedBaseUnits: 25_000_000n,
          sender: { feePayer: "VictimWalletAddress1111111111111111111111", debited: [] },
        }),
      });
      expect(attackerAttempt.ok).toBe(false);
      if (attackerAttempt.ok) return;
      expect(attackerAttempt.reason).toBe("wrong_payer");

      // The attacker's order is untouched — no colour, no seat, taken from
      // this.
      const attackerRefreshed = await orderById(attackerOrder.id);
      expect(attackerRefreshed?.status).toBe("pending");

      // The victim's own order can still be settled with the exact same
      // signature: it was never spent.
      const victimSettle = await settlePayment({
        order: victimOrder,
        signature,
        verified: okVerified(25_000_000n),
      });

      expect(victimSettle).toEqual({ ok: true, amountBaseUnits: 25_000_000n });
      const victimRefreshed = await orderById(victimOrder.id);
      expect(victimRefreshed?.status).toBe("paid");
    },
  );
  /**
   * The late paste-in, which needs no race at all: someone pays from an
   * exchange or a hardware wallet, comes back forty minutes later, and
   * pastes the signature. Real, confirmed, correctly addressed USDC, for the
   * right amount, in our wallet — just too late for this order.
   *
   * Before this, `outside_bid_window` filed nothing and claimed nothing, so
   * that money existed in our wallet and in no table anywhere. The
   * reference-key recovery pass is not a net for it either: recovery finds
   * payments by the order's reference key, and a payer paying from an
   * exchange never attached one.
   */
  it(
    "files a late payment that really reached our wallet, and still leaves its signature spendable",
    { timeout: 20_000 },
    async () => {
      const w = await war();
      const tokenId = await insertToken({ warId: w.id, colourSlot: 5, status: "reserved" });
      const order = await insertOrder({ warId: w.id, warTokenId: tokenId, amountUsd: 25 });
      const signature = randomUUID();

      const result = await settlePayment({
        order,
        signature,
        verified: failVerified(
          "outside_bid_window",
          "That transaction was not made during this order.",
          { receivedBaseUnits: 25_000_000n, sender: CHAIN_SENDER },
        ),
      });

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.reason).toBe("outside_bid_window");

      // On the record, with the amount and the sender the CHAIN reported.
      const [unmatchedRow] = await query<{
        reason: string;
        received_base_units: string;
        order_id: string | null;
        sender_fee_payer: string | null;
      }>(
        `SELECT reason, received_base_units, order_id, sender_fee_payer
           FROM unmatched_payments WHERE signature = $1`,
        [signature],
      );
      expect(unmatchedRow).toMatchObject({
        reason: "outside_bid_window",
        received_base_units: "25000000",
        order_id: order.id,
        sender_fee_payer: "OnChainFeePayer1111111111111111111111111111",
      });

      // Filing is not spending. This transfer may be exactly right for some
      // other order's window, and burning the signature would destroy that.
      const claimed = await query(`SELECT 1 FROM consumed_signatures WHERE signature = $1`, [signature]);
      expect(claimed).toHaveLength(0);

      // And the payer is told their money was recorded and where to take it
      // — never that it simply bounced.
      expect(result.message).toMatch(/filed/i);
      expect(result.supportContact).toBeDefined();

      // Idempotent: a payer who pastes the same signature twice leaves one
      // row, not two, for the operator to work through.
      await settlePayment({
        order,
        signature,
        verified: failVerified("outside_bid_window", "late", {
          receivedBaseUnits: 25_000_000n,
          sender: CHAIN_SENDER,
        }),
      });
      const rows = await query(`SELECT 1 FROM unmatched_payments WHERE signature = $1`, [signature]);
      expect(rows).toHaveLength(1);
    },
  );

  it(
    "files nothing for an out-of-window transfer that never credited our wallet",
    { timeout: 20_000 },
    async () => {
      // Nothing arrived, so there is nothing to file. A row here would be a
      // refund obligation for money nobody ever sent us.
      const w = await war();
      const tokenId = await insertToken({ warId: w.id, colourSlot: 6, status: "reserved" });
      const order = await insertOrder({ warId: w.id, warTokenId: tokenId });
      const signature = randomUUID();

      const result = await settlePayment({
        order,
        signature,
        verified: failVerified("outside_bid_window", "not during this order"),
      });

      expect(result).toEqual({
        ok: false,
        reason: "outside_bid_window",
        message: "not during this order",
      });
      const unmatched = await query(`SELECT 1 FROM unmatched_payments WHERE signature = $1`, [signature]);
      expect(unmatched).toHaveLength(0);
      const claimed = await query(`SELECT 1 FROM consumed_signatures WHERE signature = $1`, [signature]);
      expect(claimed).toHaveLength(0);
    },
  );

  /**
   * `wrong_destination` is the one permanently-spending verdict that rests
   * on evidence being ABSENT — our wallet appears in neither balance array.
   * A parseable but incomplete RPC response produces that same absence for a
   * payment that genuinely reached us, and `defaultFetchTransaction` retries
   * only on a thrown error, so one 200 with empty balance arrays is accepted
   * as truth. Claiming there burns a real payment's signature globally and
   * forever: the payer's retry gets `signature_reused`, and a recovery pass
   * skips it as `signature_reused` without filing, so the money ends up
   * recorded nowhere at all. A payment we cannot classify is not a payment
   * we may burn.
   */
  it(
    "does not spend a signature on a wrong_destination the response never established, and the retry still settles",
    { timeout: 20_000 },
    async () => {
      const w = await war();
      const tokenId = await insertToken({ warId: w.id, colourSlot: 5, status: "reserved" });
      const order = await insertOrder({ warId: w.id, warTokenId: tokenId });
      const signature = randomUUID();

      // The thin response: verifyPayment could not tell where the money
      // went, so it does not claim it went elsewhere.
      const first = await settlePayment({
        order,
        signature,
        verified: failVerified("wrong_destination", "could not be read in full"),
      });
      expect(first).toEqual({
        ok: false,
        reason: "wrong_destination",
        message: "could not be read in full",
      });

      const claimed = await query(`SELECT 1 FROM consumed_signatures WHERE signature = $1`, [signature]);
      expect(claimed).toHaveLength(0);

      // A healthy node answers the retry, and the payment lands where it
      // always belonged.
      const second = await settlePayment({ order, signature, verified: okVerified(25_000_000n) });
      expect(second).toEqual({ ok: true, amountBaseUnits: 25_000_000n });
      const refreshed = await orderById(order.id);
      expect(refreshed?.status).toBe("paid");
      const [tokenRow] = await query<{ status: string }>(`SELECT status FROM war_tokens WHERE id = $1`, [
        tokenId,
      ]);
      expect(tokenRow.status).toBe("active");
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
        // Substantiated: the RPC positively reported USDC moving to an owner
        // who is not us, which is what makes this verdict spend the
        // signature at all. An unproven wrong_destination leaves it
        // spendable — see the verification-failure suite above.
        verified: failVerified("wrong_destination", "wrong wallet", { provenNotOurs: true }),
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

      // No chain-derived sender is available on this path (verification
      // succeeded; VerifyResult's success branch carries only the amount) —
      // left honestly null rather than filled in from the order's own
      // payerPubkey, which is not something the chain itself ever asserted
      // about this second transaction.
      const [unmatchedRow] = await query<{ reason: string; sender_fee_payer: string | null }>(
        `SELECT reason, sender_fee_payer FROM unmatched_payments WHERE order_id = $1`,
        [order.id],
      );
      expect(unmatchedRow).toMatchObject({ reason: "order_already_paid", sender_fee_payer: null });
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

describe("settlePayment: a duplicate unmatched_payments row must not abort the transaction that wrote it", () => {
  /**
   * Fix round 2, Finding 1: `fileUnmatched`'s own try/catch on the
   * unmatched_payments unique violation was, for every call site that runs
   * it through `client.query` mid-transaction, the exact hazard already
   * guarded against for the colour flip in `settleLateConfirmation` —
   * catching the JS exception does not undo Postgres putting the whole
   * transaction into an aborted state. On the `already_settled` branch,
   * nothing runs after the swallowed catch, so the transaction's own
   * `COMMIT` silently degrades to a `ROLLBACK` — the call still returns a
   * normal-looking `already_settled` result, but everything that
   * transaction wrote, including the `consumed_signatures` claim made
   * moments earlier in the SAME call, vanishes. Asserting only the return
   * value is exactly what let this hide; every test below also checks what
   * is actually in the database afterwards.
   */
  it(
    "settles for real — claim included — even when the signature already has an unmatched_payments row (already_settled branch)",
    { timeout: 20_000 },
    async () => {
      const w = await war();
      const tokenId = await insertToken({ warId: w.id, colourSlot: 5, status: "reserved" });
      const order = await insertOrder({ warId: w.id, warTokenId: tokenId });
      // The order is already paid by an unrelated signature — any second
      // attempt on it reaches the already_settled branch.
      await execute(`UPDATE entry_orders SET status = 'paid', paid_at = now() WHERE id = $1`, [order.id]);

      const signature = randomUUID();
      // A row for THIS signature already exists — the exact collision
      // `fileUnmatched` will hit when the already_settled branch tries to
      // file it again.
      await execute(
        `INSERT INTO unmatched_payments
           (id, signature, order_id, received_base_units, expected_base_units, reason, created_at)
         VALUES ($1, $2, $3, '1', '1', 'pre-existing', now())`,
        [randomUUID(), signature, order.id],
      );

      const result = await settlePayment({ order, signature, verified: okVerified(25_000_000n) });

      // The call itself still reports the right thing...
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.reason).toBe("already_settled");

      // ...but the return value alone is exactly what hid the bug. What
      // matters is whether this transaction's OTHER writes actually landed:
      // consumed_signatures is the first statement of the same transaction
      // as the fileUnmatched call that collided, and a silently-degraded
      // COMMIT would erase it along with everything else.
      const [consumedRow] = await query<{ outcome: string }>(
        `SELECT outcome FROM consumed_signatures WHERE signature = $1`,
        [signature],
      );
      expect(consumedRow).toBeTruthy();
      expect(consumedRow?.outcome).toBe("verified");

      // The pre-existing row is untouched (still exactly one row for this
      // signature — the conflicting insert did nothing, not something).
      const unmatchedRows = await query(`SELECT 1 FROM unmatched_payments WHERE signature = $1`, [
        signature,
      ]);
      expect(unmatchedRows).toHaveLength(1);
    },
  );

  it(
    "reclaims the colour for real even when the signature already has an unmatched_payments row (unmatchedNoSeat)",
    { timeout: 20_000 },
    async () => {
      const w = await war({ maxTokens: 3 });
      const tokenId = await insertToken({ warId: w.id, colourSlot: 2, status: "released" });
      const order = await insertOrder({
        warId: w.id,
        warTokenId: tokenId,
        expiresAt: new Date(Date.now() - 2 * 60_000),
      });
      await execute(`UPDATE entry_orders SET status = 'expired' WHERE id = $1`, [order.id]);
      // Colour 2 was retaken in the meantime, so this late confirm will
      // land in unmatchedNoSeat — the second call site that runs
      // fileUnmatched through client.query mid-transaction.
      await insertToken({ warId: w.id, colourSlot: 2, status: "active" });

      const signature = randomUUID();
      await execute(
        `INSERT INTO unmatched_payments
           (id, signature, order_id, received_base_units, expected_base_units, reason, created_at)
         VALUES ($1, $2, $3, '1', '1', 'pre-existing', now())`,
        [randomUUID(), signature, order.id],
      );

      const result = await settlePayment({
        order: (await orderById(order.id))!,
        signature,
        verified: okVerified(25_000_000n),
      });

      // Before the fix, freeColoursOnClient — the very next statement after
      // fileUnmatched inside unmatchedNoSeat — threw 25P02 on the aborted
      // transaction, and settlePayment rejected instead of returning.
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.reason).toBe("unmatched");
      expect(result.freeColours).toBeDefined();

      const [consumedRow] = await query<{ outcome: string }>(
        `SELECT outcome FROM consumed_signatures WHERE signature = $1`,
        [signature],
      );
      expect(consumedRow?.outcome).toBe("verified");
    },
  );
});

describe("settlePayment: a settled signature closes its own open unmatched_payments row", () => {
  /**
   * Fix round 2, Finding 2. After the attack sequence proven in the
   * "verification failure" block above (an attacker posts a victim's
   * in-flight signature against their own order, collects wrong_payer, and
   * an honest but claimant-controlled unmatched_payments row gets filed),
   * the victim's own order settles the SAME signature later. Without this
   * fix the earlier row survives forever, `open`, naming the attacker's
   * order — a trap for whatever admin queue reads it next, even though the
   * money is now provably accounted for.
   */
  it(
    "marks the earlier open row applied, pointing at the order that actually settled",
    { timeout: 20_000 },
    async () => {
      const w = await war();
      const attackerTokenId = await insertToken({ warId: w.id, colourSlot: 1, status: "reserved" });
      const attackerOrder = await insertOrder({ warId: w.id, warTokenId: attackerTokenId });
      const victimTokenId = await insertToken({ warId: w.id, colourSlot: 2, status: "reserved" });
      const victimOrder = await insertOrder({ warId: w.id, warTokenId: victimTokenId });
      const signature = randomUUID();

      // The attacker's losing attempt files the row.
      await settlePayment({
        order: attackerOrder,
        signature,
        verified: failVerified("wrong_payer", "wrong wallet", {
          receivedBaseUnits: 25_000_000n,
          sender: { feePayer: "SomeRealSender11111111111111111111111111111", debited: [] },
        }),
      });
      const [beforeSettle] = await query<{ status: string; order_id: string }>(
        `SELECT status, order_id FROM unmatched_payments WHERE signature = $1`,
        [signature],
      );
      expect(beforeSettle).toMatchObject({ status: "open", order_id: attackerOrder.id });

      // The victim's own order settles it for real.
      const settled = await settlePayment({ order: victimOrder, signature, verified: okVerified(25_000_000n) });
      expect(settled.ok).toBe(true);

      const [afterSettle] = await query<{
        status: string;
        applied_order_id: string | null;
        resolved_at: Date | null;
      }>(
        `SELECT status, applied_order_id, resolved_at FROM unmatched_payments WHERE signature = $1`,
        [signature],
      );
      expect(afterSettle.status).toBe("applied");
      expect(afterSettle.applied_order_id).toBe(victimOrder.id);
      expect(afterSettle.resolved_at).toBeTruthy();
    },
  );

  it(
    "leaves no open unmatched row behind for a signature that settled cleanly on its first try",
    { timeout: 20_000 },
    async () => {
      const w = await war();
      const tokenId = await insertToken({ warId: w.id, colourSlot: 5, status: "reserved" });
      const order = await insertOrder({ warId: w.id, warTokenId: tokenId });
      const signature = randomUUID();

      const result = await settlePayment({ order, signature, verified: okVerified(25_000_000n) });

      expect(result.ok).toBe(true);
      const open = await query(`SELECT 1 FROM unmatched_payments WHERE signature = $1 AND status = 'open'`, [
        signature,
      ]);
      expect(open).toHaveLength(0);
    },
  );
});

describe("settlePayment: late confirmation", () => {
  async function expiredReservation(overrides: {
    maxTokens?: number;
    colourSlot?: number;
    expiredMinutesAgo?: number;
    contractKey?: string;
  } = {}) {
    const w = await war({ maxTokens: overrides.maxTokens ?? 24 });
    const tokenId = await insertToken({
      warId: w.id,
      colourSlot: overrides.colourSlot ?? 5,
      status: "released",
      contractKey: overrides.contractKey,
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

      // No chain-derived sender is available on this path — see the
      // "second confirm" test's identical assertion for why it stays null
      // rather than being filled from anything the order itself asserts.
      const [unmatchedRow] = await query<{ reason: string; sender_fee_payer: string | null }>(
        `SELECT reason, sender_fee_payer FROM unmatched_payments WHERE order_id = $1`,
        [order.id],
      );
      expect(unmatchedRow).toMatchObject({ reason: "colour_taken", sender_fee_payer: null });
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
    "refuses a late confirm onto a war that is still an unpublished draft",
    { timeout: 20_000 },
    async () => {
      // Same reasoning createOrder already applies: a draft war has no page
      // a payer could ever have seen, so taking money against it risks
      // owing a refund for a war that never runs.
      const { order } = await expiredReservation();
      await execute(`UPDATE wars SET status = 'draft' WHERE id = $1`, [order.warId]);

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
    "goes straight to unmatched once the grace period has passed, without touching the colour, and says so honestly",
    { timeout: 20_000 },
    async () => {
      const { tokenId, order } = await expiredReservation({ expiredMinutesAgo: 120, colourSlot: 5 });

      const result = await settlePayment({
        order,
        signature: randomUUID(),
        verified: okVerified(25_000_000n),
      });

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.reason).toBe("unmatched");

      // The colour was never touched: still released, free for anyone —
      // including a fresh order for this exact slot, which is why the
      // message must not claim the colour is "no longer available": it is
      // right there in freeColours.
      const [tokenRow] = await query<{ status: string }>(`SELECT status FROM war_tokens WHERE id = $1`, [
        tokenId,
      ]);
      expect(tokenRow.status).toBe("released");
      expect(result.freeColours).toContain(5);
      expect(result.message).not.toMatch(/no longer available/i);
      expect(result.message).toMatch(/window closed|not reclaimed automatically/i);

      const [unmatchedRow] = await query<{ reason: string }>(
        `SELECT reason FROM unmatched_payments WHERE order_id = $1`,
        [order.id],
      );
      expect(unmatchedRow.reason).toBe("late_confirm_past_grace");
    },
  );

  it(
    "tells the truth when no SUPPORT_CONTACT is configured, rather than promising a channel that does not exist",
    { timeout: 20_000 },
    async () => {
      const original = process.env.SUPPORT_CONTACT;
      delete process.env.SUPPORT_CONTACT;
      try {
        const { war: w, order } = await expiredReservation({ maxTokens: 1, colourSlot: 1 });
        await insertToken({ warId: w.id, colourSlot: 2, status: "active" });

        const result = await settlePayment({
          order,
          signature: randomUUID(),
          verified: okVerified(25_000_000n),
        });

        expect(result.ok).toBe(false);
        if (result.ok) return;
        expect(result.supportContact).toBeNull();
        expect(result.message).not.toMatch(/filed for support to match manually/i);
        expect(result.message).toMatch(/no support contact configured/i);
      } finally {
        if (original === undefined) delete process.env.SUPPORT_CONTACT;
        else process.env.SUPPORT_CONTACT = original;
      }
    },
  );

  /**
   * The colour race has a twin nobody covered, and it is the more ordinary
   * of the two: the same TOKEN re-enters the war at a DIFFERENT colour after
   * its first order expired, and then the first order's payment lands.
   *
   * The reclaim UPDATE moves one row out of 'released', which puts it back
   * into both `WHERE status <> 'released'` partial unique indexes at once.
   * Colour is free, so `war_tokens_colour_live` is happy; the token is not,
   * so `war_tokens_contract_live` fires. An earlier version of this code
   * tolerated only the first and rethrew the second, which aborted the whole
   * settlement transaction — taking with it the `unmatched_payments` row
   * that is the payer's ONLY trace of money that is sitting in our wallet,
   * and answering with a 500 that reads as transient for something that
   * repeats identically on every retry.
   */
  it(
    "files the payment when the token itself re-entered the war at another colour, rather than destroying the record",
    { timeout: 20_000 },
    async () => {
      const sharedContract = randomUUID();
      const { war: w, tokenId, order } = await expiredReservation({
        maxTokens: 24,
        colourSlot: 3,
        contractKey: sharedContract,
      });

      // The same community comes back with the same token at colour 7 —
      // legal precisely because the first row is 'released'.
      const reEntered = await insertToken({
        warId: w.id,
        colourSlot: 7,
        status: "active",
        contractKey: sharedContract,
      });

      const signature = randomUUID();
      const result = await settlePayment({
        order,
        signature,
        verified: okVerified(25_000_000n),
      });

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.reason).toBe("unmatched");
      expect(result.supportContact).toBeDefined();
      // Never "could not be checked": the money is on the record and the
      // payer is told so, plus where to take it.
      expect(result.message).toMatch(/already re-entered this war/i);
      expect(result.message).toMatch(/filed/i);

      // The whole point: the row survived, which means the transaction it
      // was written in committed rather than rolling back.
      const [unmatchedRow] = await query<{ reason: string; received_base_units: string }>(
        `SELECT reason, received_base_units FROM unmatched_payments WHERE signature = $1`,
        [signature],
      );
      expect(unmatchedRow).toMatchObject({
        reason: "contract_taken",
        received_base_units: "25000000",
      });

      // And nothing was half-applied: the expired order stays expired, its
      // released row stays released, and the live re-entry is untouched.
      const refreshed = await orderById(order.id);
      expect(refreshed?.status).toBe("expired");
      const [oldRow] = await query<{ status: string }>(`SELECT status FROM war_tokens WHERE id = $1`, [
        tokenId,
      ]);
      expect(oldRow.status).toBe("released");
      const [liveRow] = await query<{ status: string; colour_slot: number }>(
        `SELECT status, colour_slot FROM war_tokens WHERE id = $1`,
        [reEntered],
      );
      expect(liveRow).toMatchObject({ status: "active", colour_slot: 7 });
      const paymentRows = await query(`SELECT 1 FROM payments WHERE order_id = $1`, [order.id]);
      expect(paymentRows).toHaveLength(0);
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

  /**
   * Fix round 2, Finding 3: migration 002's own comment on this table says
   * "Rows outside the window are swept", but nothing did — the table grew
   * forever. The limiter itself is unaffected (it is window-scoped, so an
   * ancient row was never counted), but a table that grows forever behind a
   * comment that claims otherwise is worth closing, not just living with.
   */
  it(
    "sweeps attempts older than the rate-limit window when a new one is recorded",
    { timeout: 20_000 },
    async () => {
      const w = await war();
      const tokenId = await insertToken({ warId: w.id, colourSlot: 5, status: "reserved" });
      const order = await insertOrder({ warId: w.id, warTokenId: tokenId });

      for (let i = 0; i < 50; i++) {
        await execute(
          `INSERT INTO verification_attempts (id, order_id, ip_hash, attempted_at)
           VALUES ($1, $2, 'ip-ancient', now() - interval '400 days')`,
          [randomUUID(), randomUUID()],
        );
      }
      const before = await query(`SELECT 1 FROM verification_attempts`);
      expect(before.length).toBeGreaterThanOrEqual(50);

      await recordVerificationAttempt(order.id, "ip-fresh");

      const stale = await query(
        `SELECT 1 FROM verification_attempts WHERE attempted_at < now() - interval '1 day'`,
      );
      expect(stale).toHaveLength(0);

      // The row the sweep must NOT touch: the attempt just recorded, for
      // this order, inside the window.
      const fresh = await query(`SELECT 1 FROM verification_attempts WHERE order_id = $1`, [order.id]);
      expect(fresh).toHaveLength(1);
    },
  );
});

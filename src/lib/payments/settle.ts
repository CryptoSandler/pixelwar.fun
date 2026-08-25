import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import { isUniqueViolation, query, queryOne, transaction, violatedConstraint } from "../db";
import { LATE_CONFIRM_GRACE_MINUTES, VERIFY_LIMITS, supportContact, usdToBaseUnits } from "./config";
import type { Order } from "./orders";
import { freeColours } from "./orders";
import type { PaymentFailure, VerifyResult } from "./solana";

/**
 * Settlement: the step where a verified payment becomes a paid order and an
 * active token.
 *
 * This is the one place in the codebase where a mistake costs somebody real
 * money in either direction — a false settle gives a colour away for
 * nothing, and a failure to settle takes somebody's USDC and credits no one.
 * Every branch below either commits the full, atomic settlement (payment
 * row + order paid + token active) or leaves that trio untouched; there is
 * no state in between.
 */

export type SettleFailureReason =
  | PaymentFailure
  /** The signature was already claimed — by this order or a different one. */
  | "signature_reused"
  /** The order already has a payment, or can never have one (status 'failed'). */
  | "already_settled"
  /**
   * A verified transfer that reached our wallet but has no seat to land in:
   * a late confirmation onto a war that filled up, ended, or whose colour
   * was retaken while this payment was in flight. Filed to
   * unmatched_payments; reuniting it with its payer is manual, from /admin.
   */
  | "unmatched";

export type SettleResult =
  | { ok: true; amountBaseUnits: bigint }
  | {
      ok: false;
      reason: SettleFailureReason;
      message: string;
      /** Set only for "unmatched", and only when the war is still open. */
      freeColours?: number[];
      /** Set only for "unmatched" — where a payer with no seat is pointed. */
      supportContact?: string | null;
    };

type OrderRow = {
  id: string;
  status: string;
  war_id: string;
  war_token_id: string;
  expires_at: Date;
};

type WarRow = {
  status: string;
  ended: boolean;
  max_tokens: number;
};

/**
 * Records a payment that reached our wallet but cannot be applied to an
 * order right now. `order_id` is kept even though the payment cannot be
 * applied: it is exactly the lead an operator needs to look into it.
 *
 * `sender` is the best identity we have for who paid. `verifyPayment` only
 * reports the on-chain sender when a transfer failed to match (the case that
 * most needs it); on a payment that verified cleanly but simply arrived too
 * late for a seat, the only sender identity available here is the wallet the
 * order itself was opened with, when there was one — the connected-wallet
 * flow's `payerPubkey`. The paste-a-signature flow has no such binding, so a
 * late confirmation through it is filed with no sender on record; an
 * operator working the queue can still look the signature up on-chain.
 */
async function fileUnmatched(
  client: PoolClient,
  params: {
    signature: string;
    orderId: string;
    receivedBaseUnits: bigint;
    expectedBaseUnits: bigint;
    reason: string;
    payerPubkey: string | null;
  },
): Promise<void> {
  const senderDebited = params.payerPubkey
    ? [{ owner: params.payerPubkey, amountBaseUnits: params.receivedBaseUnits.toString() }]
    : [];
  await client.query(
    `INSERT INTO unmatched_payments
       (id, signature, order_id, received_base_units, expected_base_units, reason, created_at,
        sender_fee_payer, sender_debited)
     VALUES ($1, $2, $3, $4, $5, $6, now(), $7, $8::jsonb)`,
    [
      randomUUID(),
      params.signature,
      params.orderId,
      params.receivedBaseUnits.toString(),
      params.expectedBaseUnits.toString(),
      params.reason,
      params.payerPubkey,
      JSON.stringify(senderDebited),
    ],
  );
}

/**
 * Applies a verified payment to the order it was made for.
 *
 * `verified` is already decided — the RPC round trip happened before this
 * was called, because a database transaction must never hold open across a
 * network call. Everything this function does is a local decision the
 * database itself can make instantly, and it does it inside one transaction
 * so a verification failure or a lost race never leaves a half-applied
 * order behind.
 *
 * The signature is claimed first, unconditionally, whatever the outcome:
 * `consumed_signatures.signature` is the primary key that makes replay
 * impossible, and it is claimed by insert-and-catch, never by a check
 * beforehand a second caller could race past. A failed claim (someone got
 * there first, with this order or a different one) is the only path that
 * touches nothing else — the attempt to insert is itself the only statement
 * run, so there is nothing to roll back.
 */
export async function settlePayment(params: {
  order: Order;
  signature: string;
  verified: VerifyResult;
}): Promise<SettleResult> {
  const { order, signature, verified } = params;
  const expectedBaseUnits = usdToBaseUnits(order.amountUsd);

  return transaction(async (client) => {
    try {
      await client.query(
        `INSERT INTO consumed_signatures (signature, order_id, outcome, consumed_at)
         VALUES ($1, $2, $3, now())`,
        [signature, order.id, verified.ok ? "verified" : verified.reason],
      );
    } catch (error) {
      if (isUniqueViolation(error)) {
        return {
          ok: false,
          reason: "signature_reused",
          message: "That transaction signature has already been used.",
        };
      }
      throw error;
    }

    if (!verified.ok) {
      // The claim above is the only thing this attempt earns: no order, no
      // payment, no token ever changes for a signature that did not verify.
      return { ok: false, reason: verified.reason, message: verified.message };
    }

    const amountBaseUnits = verified.amountBaseUnits;

    // Locks the order for the rest of this transaction. A second confirm for
    // the same order — whatever signature it carries — blocks here until
    // this one commits or rolls back, then sees the true, post-settlement
    // status. That is what makes the status check below race-safe without
    // needing payments_order_unique to arbitrate it after the fact.
    const orderResult = await client.query<OrderRow>(
      `SELECT id, status, war_id, war_token_id, expires_at
         FROM entry_orders WHERE id = $1 FOR UPDATE`,
      [order.id],
    );
    const current = orderResult.rows[0];
    if (!current) {
      // Unreachable in practice — entry_orders rows are never deleted — but
      // failing closed here costs nothing.
      return {
        ok: false,
        reason: "already_settled",
        message: "That order no longer exists.",
      };
    }

    if (current.status === "paid" || current.status === "failed") {
      // A second, independently valid payment for an order that already has
      // one (or can no longer take one). The transfer is real; it simply has
      // no order left to settle into, so it is filed exactly like any other
      // payment with no seat to land in rather than silently discarded.
      await fileUnmatched(client, {
        signature,
        orderId: order.id,
        receivedBaseUnits: amountBaseUnits,
        expectedBaseUnits,
        reason: current.status === "paid" ? "order_already_paid" : "order_failed",
        payerPubkey: order.payerPubkey,
      });
      return {
        ok: false,
        reason: "already_settled",
        message:
          current.status === "paid"
            ? "This order has already been paid. Your payment has been filed for support to review."
            : "This order can no longer be paid. Your payment has been filed for support to review.",
        supportContact: supportContact(),
      };
    }

    if (current.status === "pending") {
      const flip = await client.query(
        `UPDATE war_tokens SET status = 'active', joined_at = now()
          WHERE id = $1 AND status = 'reserved' RETURNING id`,
        [current.war_token_id],
      );
      if (flip.rowCount === 0) {
        // The order says pending but its reservation is not 'reserved' —
        // should not happen, since only this function ever advances either
        // of them. File rather than lose the money silently.
        await fileUnmatched(client, {
          signature,
          orderId: order.id,
          receivedBaseUnits: amountBaseUnits,
          expectedBaseUnits,
          reason: "token_state_mismatch",
          payerPubkey: order.payerPubkey,
        });
        return {
          ok: false,
          reason: "unmatched",
          message: "This order's reservation is no longer active. Your payment has been filed for support to review.",
          supportContact: supportContact(),
        };
      }

      return finishSettlement(client, {
        order: current,
        signature,
        amountBaseUnits,
        payerPubkey: order.payerPubkey,
      });
    }

    if (current.status === "expired") {
      return settleLateConfirmation(client, {
        order: current,
        signature,
        amountBaseUnits,
        expectedBaseUnits,
        payerPubkey: order.payerPubkey,
      });
    }

    // Any other status is not one this schema defines — fail closed.
    await fileUnmatched(client, {
      signature,
      orderId: order.id,
      receivedBaseUnits: amountBaseUnits,
      expectedBaseUnits,
      reason: `unknown_order_status_${current.status}`,
      payerPubkey: order.payerPubkey,
    });
    return {
      ok: false,
      reason: "unmatched",
      message: "This order is in an unexpected state. Your payment has been filed for support to review.",
      supportContact: supportContact(),
    };
  });
}

/**
 * The late-confirm path: the reservation already expired and released its
 * colour. Inside `LATE_CONFIRM_GRACE_MINUTES` of the order's own window, and
 * only then, this tries to flip the same `war_tokens` row straight back to
 * `active` — never by inserting a new row, so the war's capacity and this
 * colour's exclusivity are exactly the same checks a fresh order would face.
 *
 * The colour-uniqueness attempt runs inside a SAVEPOINT. A unique violation
 * aborts whatever Postgres transaction it runs in unless one was taken first
 * — without it, the unmatched_payments insert that must follow a lost race
 * would itself fail with "current transaction is aborted".
 */
async function settleLateConfirmation(
  client: PoolClient,
  params: {
    order: OrderRow;
    signature: string;
    amountBaseUnits: bigint;
    expectedBaseUnits: bigint;
    payerPubkey: string | null;
  },
): Promise<SettleResult> {
  const { order, signature, amountBaseUnits, expectedBaseUnits, payerPubkey } = params;

  const graceMs = LATE_CONFIRM_GRACE_MINUTES * 60_000;
  const withinGrace = Date.now() - order.expires_at.getTime() <= graceMs;

  if (!withinGrace) {
    return unmatchedNoSeat(client, {
      order,
      signature,
      amountBaseUnits,
      expectedBaseUnits,
      payerPubkey,
      reason: "late_confirm_past_grace",
      warStillOpen: null, // unknown without a lookup this path deliberately skips
    });
  }

  const warResult = await client.query<WarRow>(
    `SELECT status, (ends_at <= now()) AS ended, max_tokens FROM wars WHERE id = $1 FOR UPDATE`,
    [order.war_id],
  );
  const war = warResult.rows[0];
  const warOpen = !!war && !war.ended && war.status !== "ended" && war.status !== "cancelled";

  if (!war || !warOpen) {
    return unmatchedNoSeat(client, {
      order,
      signature,
      amountBaseUnits,
      expectedBaseUnits,
      payerPubkey,
      reason: "war_closed",
      warStillOpen: false,
    });
  }

  const countResult = await client.query<{ count: string }>(
    `SELECT count(*) FROM war_tokens WHERE war_id = $1 AND status <> 'released'`,
    [order.war_id],
  );
  const hasRoom = Number(countResult.rows[0]?.count ?? 0) < war.max_tokens;

  if (!hasRoom) {
    return unmatchedNoSeat(client, {
      order,
      signature,
      amountBaseUnits,
      expectedBaseUnits,
      payerPubkey,
      reason: "war_full",
      warStillOpen: true,
    });
  }

  await client.query("SAVEPOINT reclaim_colour");
  let reclaimed = false;
  try {
    const flip = await client.query(
      `UPDATE war_tokens
          SET status = 'active', joined_at = now(), released_at = NULL, released_reason = NULL
        WHERE id = $1 AND status = 'released' RETURNING id`,
      [order.war_token_id],
    );
    reclaimed = (flip.rowCount ?? 0) > 0;
    await client.query("RELEASE SAVEPOINT reclaim_colour");
  } catch (error) {
    await client.query("ROLLBACK TO SAVEPOINT reclaim_colour");
    if (!isUniqueViolation(error) || violatedConstraint(error) !== "war_tokens_colour_live") {
      throw error;
    }
    reclaimed = false;
  }

  if (!reclaimed) {
    return unmatchedNoSeat(client, {
      order,
      signature,
      amountBaseUnits,
      expectedBaseUnits,
      payerPubkey,
      reason: "colour_taken",
      warStillOpen: true,
    });
  }

  return finishSettlement(client, { order, signature, amountBaseUnits, payerPubkey });
}

/** Files the payment and reports what the payer can still do about it. */
async function unmatchedNoSeat(
  client: PoolClient,
  params: {
    order: OrderRow;
    signature: string;
    amountBaseUnits: bigint;
    expectedBaseUnits: bigint;
    payerPubkey: string | null;
    reason: string;
    /** null when the war's own state was never looked up on this path. */
    warStillOpen: boolean | null;
  },
): Promise<SettleResult> {
  await fileUnmatched(client, {
    signature: params.signature,
    orderId: params.order.id,
    receivedBaseUnits: params.amountBaseUnits,
    expectedBaseUnits: params.expectedBaseUnits,
    reason: params.reason,
    payerPubkey: params.payerPubkey,
  });

  // Offering colours that do not exist to buy any more (a war that has
  // ended) would be worse than offering none.
  const remaining = params.warStillOpen === false ? [] : await freeColours(params.order.war_id);

  return {
    ok: false,
    reason: "unmatched",
    message:
      "Your payment arrived on-chain, but this colour is no longer available to claim. " +
      "It has been filed for support to match manually.",
    freeColours: remaining,
    supportContact: supportContact(),
  };
}

/** The one atomic act: payment recorded, order paid — the token was already flipped by the caller. */
async function finishSettlement(
  client: PoolClient,
  params: { order: OrderRow; signature: string; amountBaseUnits: bigint; payerPubkey: string | null },
): Promise<SettleResult> {
  await client.query(
    `INSERT INTO payments (id, signature, order_id, amount_base_units, payer, verified_at)
     VALUES ($1, $2, $3, $4, $5, now())`,
    [randomUUID(), params.signature, params.order.id, params.amountBaseUnits.toString(), params.payerPubkey],
  );

  const updated = await client.query(
    `UPDATE entry_orders SET status = 'paid', paid_at = now() WHERE id = $1 AND status = $2 RETURNING id`,
    [params.order.id, params.order.status],
  );
  if (updated.rowCount === 0) {
    // The FOR UPDATE lock taken above makes this unreachable: nothing else
    // can have changed this row since we read it. Thrown rather than
    // swallowed — an invariant this function depends on would have broken.
    throw new Error(`entry_orders ${params.order.id} changed status during settlement`);
  }

  return { ok: true, amountBaseUnits: params.amountBaseUnits };
}

// --- Verification rate limiting ------------------------------------------
//
// Every /confirm call that reaches verifyPayment spends a real RPC request,
// whether or not the signature turns out to be good. Without a limit here,
// the endpoint is both a free oracle for "is this signature good?" and a way
// to exhaust the RPC quota checkout itself depends on. Checked before the
// network call, never after — there is no point rate-limiting a call that
// already happened.
//
// Deliberately the same check-then-record shape as `tooManyOrders` in
// `POST /api/orders`: a defence-in-depth cap, not a race-safe constraint.
// Two requests landing in the same instant could both pass; that gap is
// acceptable for what this defends against (sustained abuse), and nothing
// about money correctness depends on it — that is entirely the job of
// `settlePayment`'s own transaction.

export type VerifyRateLimitResult = { limited: true; message: string } | { limited: false };

async function verificationAttempts(
  column: "order_id" | "ip_hash",
  value: string,
  windowMinutes: number,
): Promise<{ count: number; lastAttempt: Date | null }> {
  const row = await queryOne<{ count: string; last_attempt: Date | null }>(
    `SELECT count(*) AS count, max(attempted_at) AS last_attempt
       FROM verification_attempts
      WHERE ${column} = $1 AND attempted_at > now() - ($2 || ' minutes')::interval`,
    [value, String(windowMinutes)],
  );
  return { count: Number(row?.count ?? 0), lastAttempt: row?.last_attempt ?? null };
}

/** Whether a fresh verification attempt against this order, from this caller, should be refused. */
export async function verifyRateLimited(
  orderId: string,
  ipHash: string | null,
): Promise<VerifyRateLimitResult> {
  const { perOrder, perIp, windowMinutes, minIntervalSeconds } = VERIFY_LIMITS;

  const byOrder = await verificationAttempts("order_id", orderId, windowMinutes);
  if (byOrder.count >= perOrder) {
    return {
      limited: true,
      message: "Too many verification attempts for this order recently. Wait a while and try again.",
    };
  }
  if (byOrder.lastAttempt) {
    const elapsedSeconds = (Date.now() - byOrder.lastAttempt.getTime()) / 1000;
    if (elapsedSeconds < minIntervalSeconds) {
      return { limited: true, message: "Checking again too quickly. Wait a moment and retry." };
    }
  }

  if (ipHash) {
    const byIp = await verificationAttempts("ip_hash", ipHash, windowMinutes);
    if (byIp.count >= perIp) {
      return {
        limited: true,
        message: "Too many verification attempts from this address recently. Wait a while and try again.",
      };
    }
  }

  return { limited: false };
}

/** Records that a verification attempt was made, for the rate limit above to count. */
export async function recordVerificationAttempt(orderId: string, ipHash: string | null): Promise<void> {
  await query(
    `INSERT INTO verification_attempts (id, order_id, ip_hash, attempted_at) VALUES ($1, $2, $3, now())`,
    [randomUUID(), orderId, ipHash],
  );
}

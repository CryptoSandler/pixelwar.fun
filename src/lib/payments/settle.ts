import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import { execute, isUniqueViolation, query, queryOne, transaction, violatedConstraint } from "../db";
import { LATE_CONFIRM_GRACE_MINUTES, VERIFY_LIMITS, supportContact, usdToBaseUnits } from "./config";
import type { Order } from "./orders";
import type { PaymentFailure, SenderInfo, VerifyResult } from "./solana";

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
      /**
       * Where a payer whose money is on the record but not applied to a seat
       * is pointed. Set on "unmatched", and on the verification verdicts
       * that file a real transfer to `unmatched_payments` — `wrong_payer`,
       * `insufficient_amount`, `outside_bid_window`. `null` means this
       * deployment has configured no contact; absent means nothing was
       * filed, so there is nothing to contact anyone about.
       */
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
 * Runs one parameterised statement. Either `(text, values) =>
 * client.query(text, values)` (to stay on the settlement transaction's own
 * connection) or plain `execute` (a single autocommit statement, for the
 * paths that settle nothing and so need no transaction at all) satisfies
 * this.
 */
type Runner = (text: string, params: unknown[]) => Promise<unknown>;

/**
 * Records a payment that reached our wallet but cannot be applied to an
 * order right now. `order_id` is kept even though the payment cannot be
 * applied: it is exactly the lead an operator needs to look into it.
 *
 * `sender` must be the identity the chain itself reports (`VerifyResult`'s
 * `sender`), or `null` when we genuinely have none — never a value asserted
 * by whoever is calling this order theirs. `unmatched_payments.sender_fee_payer`
 * is defined by migration 002 as the on-chain fee payer specifically; filling
 * it with anything else (an order's own `payerPubkey`, say) would let an
 * operator reuniting a stray payment trust a claim nobody on the chain ever
 * made. On the paths where verification succeeded but there was simply no
 * seat left (late confirmations, a second payment on an already-paid order),
 * `verifyPayment` reports no sender at all — see the module doc on
 * `handleVerificationFailure` for why only `wrong_payer`,
 * `insufficient_amount` and `outside_bid_window` ever have one — so those
 * paths pass `null`, and an operator working the queue looks the signature
 * up on-chain directly.
 *
 * Idempotent by design: `unmatched_payments.signature` is UNIQUE, and a
 * caller can legitimately submit the same losing signature more than once
 * (a `wrong_payer` or `insufficient_amount` verdict does not change on
 * retry). The duplicate case is handled with `ON CONFLICT ... DO NOTHING`,
 * never a caught exception: on the paths that call this through `client`
 * mid-transaction (`unmatchedNoSeat`, the `already_settled` and
 * `token_state_mismatch` branches above), a caught `23505` still leaves the
 * enclosing Postgres transaction aborted — catching the exception in
 * JavaScript does not undo that. Every statement run afterwards on the same
 * client would fail with `25P02` ("current transaction is aborted"), and if
 * nothing ran afterwards, the transaction's own `COMMIT` would silently
 * degrade to a `ROLLBACK` — the call returns a normal-looking result while
 * everything that transaction wrote, including an unrelated
 * `consumed_signatures` claim made earlier in it, quietly vanishes, with no
 * way for the caller to tell. `ON CONFLICT` avoids the error entirely, so
 * there is nothing here for a caller to need a `SAVEPOINT` to survive.
 */
async function fileUnmatched(
  run: Runner,
  params: {
    signature: string;
    orderId: string | null;
    receivedBaseUnits: bigint;
    expectedBaseUnits: bigint;
    reason: string;
    sender: SenderInfo | null;
  },
): Promise<void> {
  await run(
    `INSERT INTO unmatched_payments
       (id, signature, order_id, received_base_units, expected_base_units, reason, created_at,
        sender_fee_payer, sender_debited)
     VALUES ($1, $2, $3, $4, $5, $6, now(), $7, $8::jsonb)
     ON CONFLICT (signature) DO NOTHING`,
    [
      randomUUID(),
      params.signature,
      params.orderId,
      params.receivedBaseUnits.toString(),
      params.expectedBaseUnits.toString(),
      params.reason,
      params.sender?.feePayer ?? null,
      JSON.stringify(params.sender?.debited ?? []),
    ],
  );
}

/**
 * Applies a verified payment to the order it was made for.
 *
 * `verified` is already decided — the RPC round trip happened before this
 * was called, because a database transaction must never hold open across a
 * network call. Everything past that is a local decision the database
 * itself can make instantly, and the settlement trio (payment + order +
 * token) always happens inside one transaction, so a lost race never leaves
 * a half-applied order behind.
 */
export async function settlePayment(params: {
  order: Order;
  signature: string;
  verified: VerifyResult;
}): Promise<SettleResult> {
  const { order, signature, verified } = params;
  const expectedBaseUnits = usdToBaseUnits(order.amountUsd);

  if (!verified.ok) {
    return handleVerificationFailure({ order, signature, verified, expectedBaseUnits });
  }

  return transaction(async (client) => {
    // Claimed here, on the only path that can ever settle anything:
    // `consumed_signatures.signature` is the primary key that makes one
    // signature good for at most one order, ever, and it is claimed by
    // insert-and-catch — never by a check beforehand a second caller could
    // race past. See `handleVerificationFailure` for why a signature that
    // did NOT verify is claimed only when it is provably unspendable
    // anywhere, and left alone otherwise.
    try {
      await client.query(
        `INSERT INTO consumed_signatures (signature, order_id, outcome, consumed_at)
         VALUES ($1, $2, 'verified', now())`,
        [signature, order.id],
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
      // payment with no seat to land in rather than silently discarded. No
      // chain-derived sender is available on this path (see fileUnmatched).
      await fileUnmatched((text, values) => client.query(text, values), {
        signature,
        orderId: order.id,
        receivedBaseUnits: amountBaseUnits,
        expectedBaseUnits,
        reason: current.status === "paid" ? "order_already_paid" : "order_failed",
        sender: null,
      });
      return {
        ok: false,
        reason: "already_settled",
        message:
          current.status === "paid"
            ? `This order has already been paid. Your payment has been ${filedClause()}`
            : `This order can no longer be paid. Your payment has been ${filedClause()}`,
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
        await fileUnmatched((text, values) => client.query(text, values), {
          signature,
          orderId: order.id,
          receivedBaseUnits: amountBaseUnits,
          expectedBaseUnits,
          reason: "token_state_mismatch",
          sender: null,
        });
        return {
          ok: false,
          reason: "unmatched",
          message: `This order's reservation is no longer active. Your payment has been ${filedClause()}`,
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
    await fileUnmatched((text, values) => client.query(text, values), {
      signature,
      orderId: order.id,
      receivedBaseUnits: amountBaseUnits,
      expectedBaseUnits,
      reason: `unknown_order_status_${current.status}`,
      sender: null,
    });
    return {
      ok: false,
      reason: "unmatched",
      message: `This order is in an unexpected state. Your payment has been ${filedClause()}`,
      supportContact: supportContact(),
    };
  });
}

/**
 * What a signature that did NOT verify earns, and why.
 *
 * `consumed_signatures.signature` was, in an earlier version of this
 * function, claimed unconditionally for every verdict. That was wrong, and
 * it was wrong in the dangerous direction: `not_confirmed`, `rpc_unavailable`
 * and `no_block_time` are exactly the verdicts whose own message tells the
 * payer to retry, and a wallet routinely hands the browser a signature
 * before the cluster confirms it — `not_confirmed` is the ordinary, expected
 * first answer, not an edge case. Claiming the signature there meant the
 * retry the message promised could only ever come back `signature_reused`,
 * with the real USDC already sitting in our wallet and nothing crediting it.
 * Worse, claiming it ahead of even reading the order meant it succeeded
 * against an order in ANY status: an attacker could take a bystander's
 * in-flight signature, post it against an order they control, collect
 * `wrong_payer`, and the signature was spent — permanently, and pointing at
 * the attacker's order — before its real owner ever got a chance to use it.
 *
 * The fix is to claim a signature only on a verdict that could never settle
 * ANY order, for anyone, no matter what order or wallet it were tried
 * against next — because that is the only case where "already tried, and it
 * cannot possibly have gone anywhere else" is actually true:
 *
 * - `failed_tx` — the transaction failed on-chain. Nothing transferred, ever.
 * - `wrong_token` — real balance moved, but not USDC. USDC is the only asset
 *   this system accepts from any order, so this can never become a payment.
 * - `wrong_destination`, and ONLY when `verified.provenNotOurs` is true —
 *   real USDC moved, and the response said so, but not to our (single,
 *   fixed) wallet. Same reasoning: no order in this deployment could ever
 *   accept it.
 *
 * That third condition is not decoration. `failed_tx` and `wrong_token` rest
 * on positive evidence — a recorded error, a recorded balance movement —
 * while `wrong_destination` is a fall-through reached by our wallet being
 * ABSENT from both balance arrays, and absence has a second cause: an RPC
 * response that parses, returns a transaction, and carries no token balances
 * at all. `defaultFetchTransaction` retries only on a thrown error, so one
 * such 200 is accepted as truth — and claiming on it would burn a real
 * payment's signature globally and forever, after which recovery skips it as
 * `signature_reused` without filing anything. `provenNotOurs` is
 * `verifyPayment`'s answer to "did the response actually establish this";
 * when it did not, the signature is left alone. See `VerifyResult`.
 *
 * Every other failure describes something that is, or might be, still true
 * of a DIFFERENT order: `not_confirmed` / `rpc_unavailable` / `no_block_time`
 * mean try again, possibly on the very order just tried; `wrong_payer` /
 * `insufficient_amount` / `outside_bid_window` all describe a transfer that
 * may be exactly right for some other order's price, wallet or window. None
 * of those get anywhere near `consumed_signatures` — the signature is left
 * spendable, and `verification_attempts` (already recorded by the route,
 * unconditionally, before `verifyPayment` even runs) keeps the rate limiter
 * working without needing a permanent claim.
 *
 * `wrong_payer`, `insufficient_amount` and `outside_bid_window` get one more
 * thing the others don't: all three can mean real USDC reached our wallet,
 * and `verifyPayment` reports both how much and who sent it
 * (`VerifyResult.receivedBaseUnits` / `.sender`, chain-derived, not asserted
 * by whoever is calling). That money is filed to `unmatched_payments` here —
 * this is the one place that data exists, and dropping it would mean the
 * verdicts a payer can least fix themselves are also the ones nobody
 * records. Filing and spending are separate acts: the row goes on the
 * record, the signature stays spendable.
 */
async function handleVerificationFailure(params: {
  order: Order;
  signature: string;
  verified: Extract<VerifyResult, { ok: false }>;
  expectedBaseUnits: bigint;
}): Promise<SettleResult> {
  const { order, signature, verified, expectedBaseUnits } = params;

  const neverSpendableAnywhere =
    verified.reason === "failed_tx" ||
    verified.reason === "wrong_token" ||
    // Only when the response positively established it — see
    // `VerifyResult.provenNotOurs`. `failed_tx` and `wrong_token` rest on
    // something the RPC reported; a bare `wrong_destination` rests on our
    // wallet being absent from the balance arrays, and a thin-but-parseable
    // response produces exactly that absence for a payment that really did
    // reach us. Spending the signature there burns a real payment globally
    // and forever on one bad response, and `consumed_signatures` has no
    // undo: a later recovery pass skips the signature as `signature_reused`
    // without filing anything, so the money ends up in our wallet with no
    // row in any table. A verdict we cannot substantiate is left unclaimed
    // instead — the payer can retry, and recovery can still find it.
    (verified.reason === "wrong_destination" && verified.provenNotOurs === true);

  if (neverSpendableAnywhere) {
    try {
      await execute(
        `INSERT INTO consumed_signatures (signature, order_id, outcome, consumed_at)
         VALUES ($1, $2, $3, now())`,
        [signature, order.id, verified.reason],
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
    return { ok: false, reason: verified.reason, message: verified.message };
  }

  // Money that reached our wallet is filed wherever the verdict says it
  // arrived, whether or not it can be applied. `receivedBaseUnits` is only
  // ever set by `verifyPayment` when our own wallet's USDC balance genuinely
  // went up in this transaction, so this is a fact about the chain rather
  // than a claim by whoever posted the signature.
  //
  // `outside_bid_window` is here for the case no race is needed to reach:
  // someone pays from an exchange or a hardware wallet and pastes the
  // signature forty minutes later. The transfer is real, confirmed,
  // correctly addressed and for the right amount — it is simply too late for
  // this order. Filing is the only reason support ever learns it happened;
  // the reference-key recovery pass cannot help, because a payer who paid
  // from an exchange never attached a reference for it to search on.
  //
  // Filing is NOT spending: the signature stays unclaimed on every branch
  // below, because all three of these verdicts describe a transfer that may
  // be exactly right for some other order's wallet, price or window, and
  // burning it would destroy that possibility.
  const reachedOurWallet = (verified.receivedBaseUnits ?? 0n) > 0n;
  const fileable =
    verified.reason === "wrong_payer" ||
    verified.reason === "insufficient_amount" ||
    verified.reason === "outside_bid_window";

  if (fileable && reachedOurWallet) {
    await fileUnmatched(execute, {
      signature,
      orderId: order.id,
      receivedBaseUnits: verified.receivedBaseUnits ?? 0n,
      expectedBaseUnits,
      reason: verified.reason,
      sender: verified.sender ?? null,
    });

    // The verdict's own message explains what was wrong with the payment;
    // on its own it reads as "your money went nowhere", which is untrue
    // once the row exists. Telling the payer it is recorded, and who to
    // reach, is the difference between a refusal and a lost payment.
    return {
      ok: false,
      reason: verified.reason,
      message: `${verified.message} Your payment has been ${filedClause()}`,
      supportContact: supportContact(),
    };
  }

  // not_confirmed, rpc_unavailable, no_block_time, invalid_signature,
  // not_found, an unsubstantiated wrong_destination, and any of the three
  // above that never actually credited our wallet: left entirely unclaimed
  // and unfiled. There is nothing on record to file, and the payer (or,
  // for outside_bid_window/wrong_payer/insufficient_amount, whoever the
  // transfer actually belongs to) must be able to try the same signature
  // again, here or against a different order.
  return { ok: false, reason: verified.reason, message: verified.message };
}

/**
 * The late-confirm path: the reservation already expired and released its
 * colour. Inside `LATE_CONFIRM_GRACE_MINUTES` of the order's own window, and
 * only then, this tries to flip the same `war_tokens` row straight back to
 * `active` — never by inserting a new row, so the war's capacity and this
 * colour's exclusivity are exactly the same checks a fresh order would face.
 *
 * The reclaim attempt runs inside a SAVEPOINT, and both of the unique
 * indexes it can collide with are tolerated there. A unique violation aborts
 * whatever Postgres transaction it runs in unless one was taken first —
 * without it, the unmatched_payments insert that must follow a lost race
 * would itself fail with "current transaction is aborted", and a violation
 * rethrown past this function takes the whole settlement transaction, and
 * that same row, down with it.
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
      reason: "late_confirm_past_grace",
      warStillOpen: null, // unknown without a lookup this path deliberately skips
    });
  }

  const warResult = await client.query<WarRow>(
    `SELECT status, (ends_at <= now()) AS ended, max_tokens FROM wars WHERE id = $1 FOR UPDATE`,
    [order.war_id],
  );
  const war = warResult.rows[0];
  // 'draft' is an operator's unpublished war — createOrder refuses it for
  // the same reason this does: there is no page a payer could see it from,
  // so taking money against it risks owing a refund for a war that never
  // runs. 'scheduled' is deliberately allowed — entry opens before a war
  // starts, and a late confirm onto a scheduled war is no different from a
  // fresh one.
  const warOpen =
    !!war && !war.ended && war.status !== "ended" && war.status !== "cancelled" && war.status !== "draft";

  if (!war || !warOpen) {
    return unmatchedNoSeat(client, {
      order,
      signature,
      amountBaseUnits,
      expectedBaseUnits,
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
      reason: "war_full",
      warStillOpen: true,
    });
  }

  await client.query("SAVEPOINT reclaim_colour");
  let reclaimed = false;
  // Which live claim beat this payment to the seat, when one did. Both
  // partial unique indexes are re-entered by this single UPDATE, because
  // both are `WHERE status <> 'released'` and this row is moving out of
  // 'released': `war_tokens_colour_live` (war + colour) and
  // `war_tokens_contract_live` (war + token). Either can fire, and neither
  // is exceptional — a released reservation's colour being retaken and its
  // TOKEN re-entering at a different colour are the same ordinary event seen
  // from two sides. An unrecognised violation is still rethrown: this
  // tolerates the two races it can name, not every failure.
  let blockedBy: "colour_taken" | "contract_taken" | null = null;
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
    // The SAVEPOINT is what makes this survivable at all, and it is the
    // whole fix: rethrowing here would abort the enclosing transaction, and
    // `transaction()` would roll back the `unmatched_payments` row that the
    // path below exists to guarantee along with it. A record written inside
    // a transaction that then rolls back is not a record. Rolling back to
    // the savepoint instead leaves the transaction alive and writable, so
    // the payment is filed and COMMITTED on both losing races.
    await client.query("ROLLBACK TO SAVEPOINT reclaim_colour");
    const constraint = isUniqueViolation(error) ? violatedConstraint(error) : "";
    if (constraint === "war_tokens_colour_live") {
      blockedBy = "colour_taken";
    } else if (constraint === "war_tokens_contract_live") {
      blockedBy = "contract_taken";
    } else {
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
      // No violation at all means the UPDATE simply matched nothing: the row
      // is no longer 'released', so something else already has this seat.
      reason: blockedBy ?? "colour_taken",
      warStillOpen: true,
    });
  }

  return finishSettlement(client, { order, signature, amountBaseUnits, payerPubkey });
}

/**
 * Colour slots this war has no live claim on, read through the SAME client
 * (and therefore the same transaction) that is already holding this row's
 * locks — not `orders.ts`'s pool-backed `freeColours`, which would borrow a
 * second connection from the pool while this one sits mid-transaction. Under
 * a small pool that second connection can simply not be available until this
 * transaction finishes, which it cannot do until that connection is granted
 * — measured directly: two concurrent late confirms losing a colour race,
 * `DATABASE_POOL_MAX=2`, one blocked over 13 seconds and then failed on a
 * pool connection timeout, losing the very unmatched_payments row this
 * function exists to guarantee. A plain, non-locking read on the
 * transaction's own connection has no such wait.
 */
async function freeColoursOnClient(client: PoolClient, warId: string): Promise<number[]> {
  const warResult = await client.query<{ max_tokens: number }>(
    `SELECT max_tokens FROM wars WHERE id = $1`,
    [warId],
  );
  const war = warResult.rows[0];
  if (!war) return [];

  const taken = await client.query<{ colour_slot: number }>(
    `SELECT colour_slot FROM war_tokens WHERE war_id = $1 AND status <> 'released'`,
    [warId],
  );
  const takenSlots = new Set(taken.rows.map((row) => row.colour_slot));

  const free: number[] = [];
  for (let slot = 1; slot <= war.max_tokens; slot++) {
    if (!takenSlots.has(slot)) free.push(slot);
  }
  return free;
}

const UNMATCHED_MESSAGES: Record<string, string> = {
  colour_taken: "Someone else claimed this colour before your payment arrived.",
  contract_taken:
    "This token already re-entered this war under a different colour before your payment arrived.",
  war_full: "This war's seats filled before your payment arrived.",
  war_closed: "This war is no longer open for entry.",
  late_confirm_past_grace:
    "Too much time passed after your reservation window closed, so this colour was not reclaimed automatically.",
};

/** Files the payment and reports what the payer can still do about it. */
async function unmatchedNoSeat(
  client: PoolClient,
  params: {
    order: OrderRow;
    signature: string;
    amountBaseUnits: bigint;
    expectedBaseUnits: bigint;
    reason: string;
    /** null when the war's own state was never looked up on this path. */
    warStillOpen: boolean | null;
  },
): Promise<SettleResult> {
  // No chain-derived sender is available here: verification succeeded, and
  // `VerifyResult`'s success branch carries only the amount, not who sent
  // it. See fileUnmatched's doc comment.
  await fileUnmatched((text, values) => client.query(text, values), {
    signature: params.signature,
    orderId: params.order.id,
    receivedBaseUnits: params.amountBaseUnits,
    expectedBaseUnits: params.expectedBaseUnits,
    reason: params.reason,
    sender: null,
  });

  // Offering colours that do not exist to buy any more (a war that has
  // ended) would be worse than offering none. Otherwise, still computed
  // even for a past-grace confirm: the colour that just missed its window is
  // itself untouched and free, and this is how a payer finds that out.
  const remaining =
    params.warStillOpen === false ? [] : await freeColoursOnClient(client, params.order.war_id);

  const reasonMessage = UNMATCHED_MESSAGES[params.reason] ?? "Your payment could not be matched to a seat.";

  return {
    ok: false,
    reason: "unmatched",
    message: `${reasonMessage} Your payment has been ${filedClause()}`,
    freeColours: remaining,
    supportContact: supportContact(),
  };
}

/**
 * The closing clause every "your payment could not be applied" message ends
 * with — honest about whether there is actually anywhere for it to go.
 * `supportContact()` returning null means this deployment has not configured
 * one; saying "filed for support" regardless would promise a channel that
 * does not exist. The row is filed either way — `unmatched_payments` is
 * where an operator would look once one IS configured — but the payer is
 * told the truth about what happens next.
 */
function filedClause(): string {
  const contact = supportContact();
  return contact
    ? `filed for support to match manually — contact ${contact} with your transaction signature.`
    : "filed for manual review. This deployment has no support contact configured yet.";
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

  // This exact signature can already have an 'open' unmatched_payments row:
  // an earlier attempt against a DIFFERENT order (an honest mismatch, or an
  // attacker posting someone else's in-flight signature against an order
  // they control) files one without ever claiming the signature — that is
  // the whole point of leaving wrong_payer/insufficient_amount spendable.
  // Now that this signature has genuinely settled something, that row is
  // answered: closing it here, in the same transaction, is what keeps an
  // operator's queue from being handed a trap that names the wrong order
  // for money that already went where it belonged.
  await client.query(
    `UPDATE unmatched_payments
        SET status = 'applied', resolved_at = now(), applied_order_id = $2,
            resolution_note = 'Automatically resolved: this signature settled a different order on a later attempt.'
      WHERE signature = $1 AND status = 'open'`,
    [params.signature, params.order.id],
  );

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
  await pruneVerificationAttempts();
}

/**
 * Sweeps rows the rate limiter can no longer see: migration 002's own
 * comment on this table says "Rows outside the window are swept", but
 * nothing did — this table grew forever, silently, behind a comment that
 * claimed otherwise. Run from the limiter's own write path rather than a
 * separate cron: every confirm attempt already pays for one row insert, and
 * this table is inherently low-volume (VERIFY_LIMITS bounds how many rows
 * any one order or caller can even produce), so sweeping on the same trip
 * costs nothing extra worth a second scheduled job for.
 */
async function pruneVerificationAttempts(): Promise<void> {
  await execute(
    `DELETE FROM verification_attempts WHERE attempted_at <= now() - ($1 || ' minutes')::interval`,
    [String(VERIFY_LIMITS.windowMinutes)],
  );
}

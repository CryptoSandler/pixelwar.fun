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
      // The war itself, before the seat. A reservation being live says nothing
      // about whether the war it belongs to still is: `expireStaleOrders`
      // closes an order's window, but nothing closes a war's orders when the
      // war ends, so a `pending` order can outlive its war by however long is
      // left on its clock.
      //
      // **Do not remove this as redundant because the window is short.** The
      // window is only short when the reservation is honest — and this branch
      // is also reached by `settleAssignedPayment`'s equivalent, where an
      // operator can arrive weeks later with no window at all. It was missing
      // here first, and that is what made it missing there: a race measured in
      // minutes on the payer path became unbounded the moment a human could
      // drive the same branch. The narrowness of a hole is not a reason to
      // leave it; it is only a reason nobody noticed.
      //
      // `warIsOpen`, never `warHasRoom`: this order already holds a `reserved`
      // seat that the capacity count includes, so asking about capacity would
      // refuse a full war's own last legitimate payment. See `warHasRoom`.
      const open = await warIsOpen(client, current.war_id);
      if (!open.ok) {
        // Real money that arrived for a war that is over. Filed exactly like
        // any other payment with no seat to land in, rather than settled into
        // a war nobody can paint on.
        return unmatchedNoSeat(client, {
          order: current,
          signature,
          amountBaseUnits,
          expectedBaseUnits,
          reason: "war_closed",
          warStillOpen: false,
        });
      }

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
 * The two decisions underneath it — is there room in this war, and can this
 * released row be taken back — live in `warHasRoom` and `reclaimReleasedSeat`
 * below, because `settleAssignedPayment` has to ask exactly the same two
 * questions in exactly the same way. Behaviour here is unchanged by that
 * move; what changed is that there is now one implementation of colour
 * exclusivity rather than a second one waiting to be written.
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

  const room = await warHasRoom(client, order.war_id);
  if (!room.ok) {
    return unmatchedNoSeat(client, {
      order,
      signature,
      amountBaseUnits,
      expectedBaseUnits,
      reason: room.reason,
      // A closed war has no colours left to offer; a full one still does the
      // instant somebody leaves, so the distinction is kept.
      warStillOpen: room.reason === "war_closed" ? false : true,
    });
  }

  const seat = await reclaimReleasedSeat(client, order.war_token_id);
  if (!seat.ok) {
    return unmatchedNoSeat(client, {
      order,
      signature,
      amountBaseUnits,
      expectedBaseUnits,
      reason: seat.reason,
      warStillOpen: true,
    });
  }

  return finishSettlement(client, { order, signature, amountBaseUnits, payerPubkey });
}

/**
 * Is this war still open for entry at all?
 *
 * The half of the seat question that has nothing to do with capacity: has this
 * war ended, been cancelled, or never been published. **Every path that seats
 * a token asks this**, including the two that hold a live reservation and so
 * need no capacity check — see `warHasRoom` for why those two must NOT ask the
 * capacity half.
 *
 * `FOR UPDATE` on the war row, on all of them. Capacity genuinely needs it (a
 * count is only true while nothing else can insert), and taking it here too
 * means every settlement path locks `wars` at the same point in the same
 * order, rather than some of them locking it and some not.
 */
/**
 * What a war check answers. Named because `settleAssignedPayment` holds one
 * between taking the lock and acting on it — see the lock ordering there.
 */
type SeatVerdict = { ok: true } | { ok: false; reason: "war_closed" | "war_full" };

async function warIsOpen(
  client: PoolClient,
  warId: string,
): Promise<{ ok: true; maxTokens: number } | { ok: false; reason: "war_closed" }> {
  const warResult = await client.query<WarRow>(
    `SELECT status, (ends_at <= now()) AS ended, max_tokens FROM wars WHERE id = $1 FOR UPDATE`,
    [warId],
  );
  const war = warResult.rows[0];
  // 'draft' is an operator's unpublished war — createOrder refuses it for
  // the same reason this does: there is no page a payer could see it from,
  // so taking money against it risks owing a refund for a war that never
  // runs. 'scheduled' is deliberately allowed — entry opens before a war
  // starts, and a late confirm onto a scheduled war is no different from a
  // fresh one.
  const open =
    !!war && !war.ended && war.status !== "ended" && war.status !== "cancelled" && war.status !== "draft";

  if (!war || !open) return { ok: false, reason: "war_closed" };
  return { ok: true, maxTokens: war.max_tokens };
}

/**
 * Is this war open, AND has it room for one more token?
 *
 * For the paths that are taking a seat the war does not currently count: a
 * `released` reservation being reclaimed, whether by a payer's late confirm or
 * by an operator's assignment. Both add one to the live count, so both must
 * ask whether there is room for it.
 *
 * **The paths holding a `reserved` reservation must call `warIsOpen` instead,
 * and this is not a shortcut.** The count below is `status <> 'released'`,
 * which already includes that order's own reserved seat — so a war that is
 * exactly full *including* the seat being paid for would refuse a perfectly
 * legitimate settlement as `war_full`. Capacity is a question about adding a
 * seat, and those paths are not adding one.
 *
 * An operator assigning a filed payment must not be able to seat a token into
 * a war that has ended or filled — "a human decided it" is authorisation,
 * never an exemption from the war's own rules.
 */
async function warHasRoom(
  client: PoolClient,
  warId: string,
): Promise<{ ok: true } | { ok: false; reason: "war_closed" | "war_full" }> {
  const open = await warIsOpen(client, warId);
  if (!open.ok) return open;

  const countResult = await client.query<{ count: string }>(
    `SELECT count(*) FROM war_tokens WHERE war_id = $1 AND status <> 'released'`,
    [warId],
  );
  const hasRoom = Number(countResult.rows[0]?.count ?? 0) < open.maxTokens;

  return hasRoom ? { ok: true } : { ok: false, reason: "war_full" };
}

/**
 * Colour exclusivity: flip a released reservation straight back to `active`,
 * or lose the race and say which of the two live claims won.
 *
 * Never by inserting a new row — the war's capacity and this colour's
 * exclusivity are then exactly the same checks a fresh order would face.
 *
 * The reclaim attempt runs inside a SAVEPOINT, and both of the unique indexes
 * it can collide with are tolerated there. A unique violation aborts whatever
 * Postgres transaction it runs in unless one was taken first — without it, the
 * unmatched_payments insert that must follow a lost race would itself fail
 * with "current transaction is aborted", and a violation rethrown past this
 * function takes the whole settlement transaction, and that same row, down
 * with it.
 *
 * ONE implementation, two callers: the payer's own late confirm
 * (`settleLateConfirmation`) and the operator's assignment
 * (`settleAssignedPayment`). That is the whole point — a second copy of this
 * block is a second place for colour exclusivity to be got wrong, and the
 * admin path has no chain evidence backing it.
 */
async function reclaimReleasedSeat(
  client: PoolClient,
  tokenId: string,
): Promise<{ ok: true } | { ok: false; reason: "colour_taken" | "contract_taken" }> {
  await client.query("SAVEPOINT reclaim_colour");
  // Which live claim beat this payment to the seat, when one did. Both
  // partial unique indexes are re-entered by this single UPDATE, because
  // both are `WHERE status <> 'released'` and this row is moving out of
  // 'released': `war_tokens_colour_live` (war + colour) and
  // `war_tokens_contract_live` (war + token). Either can fire, and neither
  // is exceptional — a released reservation's colour being retaken and its
  // TOKEN re-entering at a different colour are the same ordinary event seen
  // from two sides. An unrecognised violation is still rethrown: this
  // tolerates the two races it can name, not every failure.
  try {
    const flip = await client.query(
      `UPDATE war_tokens
          SET status = 'active', joined_at = now(), released_at = NULL, released_reason = NULL
        WHERE id = $1 AND status = 'released' RETURNING id`,
      [tokenId],
    );
    await client.query("RELEASE SAVEPOINT reclaim_colour");
    // No violation at all means the UPDATE simply matched nothing: the row
    // is no longer 'released', so something else already has this seat.
    return (flip.rowCount ?? 0) > 0 ? { ok: true } : { ok: false, reason: "colour_taken" };
  } catch (error) {
    // The SAVEPOINT is what makes this survivable at all, and it is the
    // whole fix: rethrowing here would abort the enclosing transaction, and
    // `transaction()` would roll back the `unmatched_payments` row that the
    // caller exists to guarantee along with it. A record written inside a
    // transaction that then rolls back is not a record. Rolling back to the
    // savepoint instead leaves the transaction alive and writable, so the
    // payment is filed and COMMITTED on both losing races.
    await client.query("ROLLBACK TO SAVEPOINT reclaim_colour");
    const constraint = isUniqueViolation(error) ? violatedConstraint(error) : "";
    if (constraint === "war_tokens_colour_live") return { ok: false, reason: "colour_taken" };
    if (constraint === "war_tokens_contract_live") return { ok: false, reason: "contract_taken" };
    throw error;
  }
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

/**
 * The one atomic act: payment recorded, order paid — the token was already
 * flipped by the caller.
 *
 * ## Why `unmatched_payments` is written BEFORE `payments`
 *
 * It reads backwards — the row is being closed because the signature settled,
 * so closing it after the settlement is the natural order — and it was written
 * that way first. It is deliberately the other way round now, and the reason
 * is lock ordering across the two callers.
 *
 * `settleAssignedPayment` must lock its `unmatched_payments` row FIRST: that
 * lock IS its idempotency token, the thing that makes a double-click block
 * rather than double-settle, so it cannot be moved later without destroying
 * the guarantee. It then reaches `payments` last, through this function. If
 * this function took `payments` before `unmatched_payments`, the two paths
 * would acquire the same two resources in opposite orders, and two
 * transactions in flight on the same signature would deadlock — 40P01,
 * uncaught on both sides, a 500 for the payer.
 *
 * So the order is settled here, at the shared end, where one line fixes both
 * callers: **`unmatched_payments`, then `payments`.** Both statements are in
 * the same transaction, so a failure in either still rolls back both, and no
 * caller can observe the intermediate state.
 *
 * That is one pair. **It is not the only pair, and reasoning about one pair is
 * how the others were missed** — this comment used to end "nothing else
 * changes", which was true and was the problem. The whole ordering, for both
 * paths, is written out at the top of `settleAssignedPayment`'s transaction;
 * change either path's locks only against that list.
 */
async function finishSettlement(
  client: PoolClient,
  params: { order: OrderRow; signature: string; amountBaseUnits: bigint; payerPubkey: string | null },
): Promise<SettleResult> {
  // This exact signature can already have an 'open' unmatched_payments row:
  // an earlier attempt against a DIFFERENT order (an honest mismatch, or an
  // attacker posting someone else's in-flight signature against an order
  // they control) files one without ever claiming the signature — that is
  // the whole point of leaving wrong_payer/insufficient_amount spendable.
  // This signature is about to settle something, so that row is answered:
  // closing it here, in the same transaction, is what keeps an operator's
  // queue from being handed a trap that names the wrong order for money that
  // already went where it belonged.
  await client.query(
    `UPDATE unmatched_payments
        SET status = 'applied', resolved_at = now(), applied_order_id = $2,
            resolution_note = 'Automatically resolved: this signature settled a different order on a later attempt.'
      WHERE signature = $1 AND status = 'open'`,
    [params.signature, params.order.id],
  );

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

// --- Assignment, from /admin/orphans -------------------------------------

export type AssignFailureReason =
  /** No `unmatched_payments` row with this id. */
  | "not_found"
  /** The row is no longer `open`. THE double-click answer — see the doc below. */
  | "already_resolved"
  | "order_not_found"
  /** The order is `paid` or `failed`: it can never take a payment. */
  | "order_not_assignable"
  /** The order says `pending` but its reservation is not `reserved`. */
  | "token_state_mismatch"
  /** `payments.signature` UNIQUE fired: this signature has already settled something. */
  | "signature_settled"
  /** `payments_order_unique` fired: this order already holds a payment. */
  | "order_already_paid"
  | "war_closed"
  | "war_full"
  | "colour_taken"
  | "contract_taken";

export type AssignResult =
  | { ok: true; orderId: string; amountBaseUnits: bigint }
  | { ok: false; reason: AssignFailureReason; message: string };

const ASSIGN_MESSAGES: Record<AssignFailureReason, string> = {
  not_found: "That filed payment no longer exists.",
  already_resolved: "That payment has already been resolved. Nothing was changed.",
  order_not_found: "That order does not exist.",
  order_not_assignable: "That order has already been paid, or can no longer be paid.",
  token_state_mismatch:
    "That order's colour reservation is not in the state the order claims. Do not assign to it.",
  signature_settled: "That signature has already paid for an order. Nothing was changed.",
  order_already_paid: "That order already holds a payment. Nothing was changed.",
  war_closed: "That war is no longer open for entry.",
  war_full: "That war has no seats left.",
  colour_taken: "That order's colour is held by someone else now.",
  contract_taken: "That token has already re-entered this war under a different colour.",
};

/**
 * Thrown to abandon the settlement transaction with a typed answer.
 *
 * The ledger conflicts below are detected AFTER the seat has been flipped to
 * `active` inside this transaction. Returning `{ ok: false }` from the
 * callback would COMMIT that flip (see `transaction()` in `db.ts`, which
 * commits whenever the callback returns without throwing) — a token made
 * active with no payment behind it, which is exactly the half-applied state
 * this module exists to make impossible. Throwing rolls the whole thing back,
 * and the catch outside turns it back into a normal result. A SAVEPOINT would
 * be the wrong tool: the point is not to survive the error, it is to undo
 * everything that came before it.
 */
class AssignConflict extends Error {
  constructor(readonly reason: AssignFailureReason) {
    super(reason);
  }
}

type UnmatchedRow = {
  id: string;
  signature: string;
  received_base_units: string;
  status: string;
  sender_fee_payer: string | null;
};

/**
 * Applies a filed payment to an order an operator chose.
 *
 * **This is the only path in this project where money moves on a human's
 * say-so.** Every other settlement is decided by chain evidence. So it is not
 * a second settlement — it is a second, differently-authorised ENTRY into the
 * first one. The war checks are `warIsOpen` and `warHasRoom`, the colour
 * exclusivity is `reclaimReleasedSeat`, and the settlement itself is
 * `finishSettlement`, all shared verbatim with the payer's own path. Nothing
 * here writes its own UPDATE against `entry_orders`, `war_tokens` or
 * `payments`.
 *
 * WHO CALLS THIS: `POST /api/admin/orphans/[id]/assign`, guarded by the admin
 * session. Nothing else, ever — `operatorLabel` is the caller asserting a
 * human authorised this, and only an authenticated route may assert it.
 *
 * ## Why this does not claim `consumed_signatures`
 *
 * The two tables answer different questions. `consumed_signatures` is an
 * ATTEMPT LOG: it stops a signature being *tried* twice. `payments` is the
 * LEDGER: `payments.signature UNIQUE` stops a signature being *settled* twice,
 * and `payments_order_unique` stops an order holding two payments.
 *
 * This path skips the attempt log because the attempt already happened and is
 * already recorded. That is precisely why there is an `unmatched_payments` row
 * to assign at all: eight of the eleven reasons a row can carry were filed by
 * a settlement that had already committed the `consumed_signatures` claim.
 * Re-claiming a signature that is by definition already claimed would be the
 * incoherent act here, not the safe one — it would refuse every one of those
 * eight rows forever, which is the defect this function exists to fix.
 *
 * ## What actually stops a payer re-settling a signature this path already spent
 *
 * **Read this before widening anything.** An earlier version of this comment
 * said the two paths "converge on the ledger", so the property is enforced
 * identically for both. That is true of the OUTCOME and false of the
 * ENFORCEMENT, and the difference matters to whoever changes this next.
 *
 * `settlePayment` has no handler for `payments_signature_key` or
 * `payments_order_unique`. Its only signature guard is the
 * `consumed_signatures` insert-and-catch at the top of its transaction, and
 * `POST /api/orders/[id]/confirm` does not try/catch it either. So on the
 * payer path the ledger does not REFUSE, it THROWS: a 23505 out to a 500,
 * not a `signature_reused`. This function is the only one that translates
 * those two constraints into typed answers.
 *
 * What keeps the payer path off a signature this one already spent is
 * therefore not the ledger. It is two other things, and this path is exempt
 * from both:
 *
 * 1. **The `consumed_signatures` claim**, for the eight in-settlement filing
 *    reasons. Those signatures are already claimed, so `settlePayment` returns
 *    `signature_reused` long before `finishSettlement`.
 * 2. **`verifyPayment`'s `createdAtMs` bound**, for the other three
 *    (`wrong_payer`, `insufficient_amount`, `outside_bid_window`), which are
 *    deliberately left unclaimed. A signature can never verify against an
 *    order created after it, so it cannot be re-presented inside a fresher
 *    order's window. The recovery pass widens `expiresAtMs` to `now()`, which
 *    defeats that for `outside_bid_window`. Past `RECOVERY_MAX_AGE_DAYS` the
 *    widening is withdrawn and the order's own `expiresAt` comes back; past
 *    `LATE_CONFIRM_GRACE_MINUTES` the reclaim is refused before
 *    `finishSettlement` is reached.
 *
 *    **Inside the grace window it is reachable, and the consequence is a 500.**
 *    Stated plainly rather than left as "caught": within
 *    `LATE_CONFIRM_GRACE_MINUTES` of an order expiring, a recovery pass can
 *    re-verify a signature this path has already assigned, reclaim the seat,
 *    and reach `finishSettlement`, whose `payments` INSERT then hits
 *    `payments_signature_key` — the constraint `settlePayment` has no handler
 *    for. The 23505 escapes `settlePayment`, escapes
 *    `recoverUnclaimedOrders`'s per-order `try`/`finally` (a `finally` with no
 *    `catch`), and aborts the rest of that pass; `POST /api/cron/reconcile`
 *    answers 500 and the workflow's JSON assertion correctly fails the run.
 *    Money is safe — the transaction rolls back — the poisoned order is stamped
 *    by the `finally` so the next pass sorts it last, and the whole thing
 *    self-clears once the order passes grace. The fix is the same three lines
 *    this function already has below; it is not applied to `settlePayment`
 *    here because that is a change to the payer's own money path.
 *
 * Nothing is broken today: no sequence exists where the ledger and the seat
 * disagree, because every refusal reachable after a durable write in either
 * transaction is a throw, and `transaction()` rolls back on throw. But the
 * day someone widens a verification window, adds a reason to the filing set,
 * or drops the grace bound, the failure mode on the payer side is a 500 and
 * not a refusal. The three-line fix is the one this function already has —
 * see the `isUniqueViolation` branch below. It is not applied to
 * `settlePayment` here because that is a change to the payer's own money path
 * and belongs to whoever owns that decision, not to a comment.
 *
 * ## Idempotent under a double-click
 *
 * The `unmatched_payments` row is the idempotency token. It is locked FOR
 * UPDATE before any decision is made on it, and only a row still `open` is
 * acted on. A second request — a double-click, a retried POST, two operators
 * at once — blocks on that lock until the first commits, then reads the true
 * post-settlement `status` and returns `already_resolved` having touched
 * nothing. That is a lock, not a check-then-act, so there is no window between
 * the read and the write for a second caller to slip through.
 *
 * **It is taken third, not first, and that was a deadlock fix.** It used to be
 * the transaction's opening statement, which read like the stronger claim and
 * was in fact the dangerous one: `settlePayment` takes `entry_orders` and
 * `wars` before it ever reaches the filed row, so opening with
 * `unmatched_payments` had the two money paths acquiring the same rows in
 * opposite orders. What the guarantee actually needs is that nothing is
 * WRITTEN before the lock is held and the `status` is read under it — not that
 * the lock comes first — and that is still exactly true.
 *
 * Underneath the lock, `payments.signature UNIQUE` and `payments_order_unique`
 * are the backstop for THIS path — the same signature cannot settle twice and
 * the same order cannot be paid twice, whatever the application believes — and
 * they are translated into typed refusals below rather than left to throw.
 */
export async function settleAssignedPayment(params: {
  /** `unmatched_payments.id` — the filed payment being applied. */
  unmatchedId: string;
  /** The order the operator chose for it. */
  orderId: string;
  /** `admin_sessions.token_label`. Never a token, never a session id. */
  operatorLabel: string;
}): Promise<AssignResult> {
  const { unmatchedId, orderId, operatorLabel } = params;

  try {
    return await transaction(async (client): Promise<AssignResult> => {
      // --- Locks, in `settlePayment`'s order ------------------------------
      //
      // entry_orders, then wars, then unmatched_payments. That order is not a
      // preference, it is the whole of the deadlock fix: `settlePayment` takes
      // entry_orders, then wars, then reaches the filed row last through
      // `finishSettlement`'s qualified UPDATE. Two transactions taking the same
      // two rows in opposite orders is the textbook cycle, and `40P01` is
      // caught nowhere in this codebase — `isUniqueViolation` only matches
      // `23505` — so it surfaces as a 500 on the payer's /confirm, on this
      // assignment, or on the reconcile cron.
      //
      // The one pair still acquired in different orders is
      // {war_tokens, unmatched_payments}, and it cannot cycle: `war_tokens` is
      // only ever locked through `order.war_token_id`, and
      // `entry_orders_token_unique` makes that one-to-one with the order — so
      // two transactions wanting the same `war_tokens` row necessarily want the
      // same `entry_orders` row, which they both take first, and they
      // serialise there instead.
      const orderResult = await client.query<OrderRow>(
        `SELECT id, status, war_id, war_token_id, expires_at
           FROM entry_orders WHERE id = $1 FOR UPDATE`,
        [orderId],
      );
      const order = orderResult.rows[0];

      // The war's row, locked HERE rather than beside the check it feeds.
      //
      // Splitting the lock from its verdict is what lets the lock move ahead of
      // `unmatched_payments` without changing which refusal a caller sees: the
      // verdict is not acted on until below, in the same position it always
      // held. Skipped entirely for an order that can never be assigned to —
      // skipping a lock cannot create a cycle, only taking one out of order can.
      //
      // `warIsOpen` for `pending`, `warHasRoom` for `expired`: the pending
      // order's own `reserved` seat is already inside the capacity count, so
      // asking about capacity there would refuse the last legitimate assignment
      // in a full war. Only the reclaim branch is ADDING a seat. See
      // `warHasRoom`.
      let seat: SeatVerdict | null = null;
      if (order?.status === "pending") {
        seat = await warIsOpen(client, order.war_id);
      } else if (order?.status === "expired") {
        seat = await warHasRoom(client, order.war_id);
      }

      // The idempotency token. Taken last of the three, and that is safe:
      // nothing has been WRITTEN yet, so the guarantee was never about being
      // first — it is about this row being under `FOR UPDATE` before any
      // decision is made on it, which it is.
      const filedResult = await client.query<UnmatchedRow>(
        `SELECT id, signature, received_base_units, status, sender_fee_payer
           FROM unmatched_payments WHERE id = $1 FOR UPDATE`,
        [unmatchedId],
      );
      const filed = filedResult.rows[0];

      // --- Verdicts, in their original precedence -------------------------
      //
      // The filed row first, so a double-click still answers `already_resolved`
      // rather than whatever became true of the order in the meantime.
      if (!filed) return refuseAssignment("not_found");
      if (filed.status !== "open") return refuseAssignment("already_resolved");

      if (!order) return refuseAssignment("order_not_found");
      if (order.status !== "pending" && order.status !== "expired") {
        // `paid` and `failed` can never take a payment; any other status is not
        // one this schema defines. Fail closed on both.
        return refuseAssignment("order_not_assignable");
      }
      if (seat && !seat.ok) return refuseAssignment(seat.reason);

      if (order.status === "pending") {
        // Its reservation is still live and holding the colour, so there is no
        // race to lose: the same flip `settlePayment` does.
        const flip = await client.query(
          `UPDATE war_tokens SET status = 'active', joined_at = now()
            WHERE id = $1 AND status = 'reserved' RETURNING id`,
          [order.war_token_id],
        );
        if (flip.rowCount === 0) return refuseAssignment("token_state_mismatch");
      } else {
        // The reservation lapsed and released its colour. Taking it back faces
        // the same two partial unique indexes a payer's late confirm faces, in
        // the same code. Deliberately NOT gated on LATE_CONFIRM_GRACE_MINUTES:
        // that window bounds what happens automatically, and a human looking at
        // a filed payment weeks later is the case this screen exists for. What
        // it may never do is take a seat that is gone.
        const reclaimed = await reclaimReleasedSeat(client, order.war_token_id);
        if (!reclaimed.ok) return refuseAssignment(reclaimed.reason);
      }

      let settled: SettleResult;
      try {
        settled = await finishSettlement(client, {
          order,
          signature: filed.signature,
          amountBaseUnits: BigInt(filed.received_base_units),
          // The chain's own fee payer, never the order's `payer_pubkey`. The
          // whole reason `sender_fee_payer` exists (migration 002) is that
          // reuniting a stray payment must not mean trusting a claim about who
          // paid it, and an order's payer field is exactly such a claim — on a
          // `wrong_payer` row it is provably the wrong wallet. Null when the
          // filing path had no sender to record; a lie would be worse.
          payerPubkey: filed.sender_fee_payer,
        });
      } catch (error) {
        // The ledger refusing the write. Thrown onward, never returned, so the
        // seat flip above is rolled back with it — see `AssignConflict`.
        if (isUniqueViolation(error)) {
          const constraint = violatedConstraint(error);
          if (constraint === "payments_signature_key") throw new AssignConflict("signature_settled");
          if (constraint === "payments_order_unique") throw new AssignConflict("order_already_paid");
        }
        throw error;
      }

      if (!settled.ok) {
        // `finishSettlement` returns only `{ ok: true }` or throws. Unreachable,
        // and failing closed costs nothing.
        throw new AssignConflict("order_not_assignable");
      }

      // `finishSettlement` has already closed this row with its own automatic
      // note (it looks for any 'open' row on this signature, which is ours).
      // Overwritten here, in the same transaction, so what survives is the
      // truth: a human did this, and here is which one. Same transaction as
      // the settlement, so an applied row and an unsettled payment cannot
      // exist separately in either direction.
      await client.query(
        `UPDATE unmatched_payments
            SET status = 'applied', resolved_at = now(), applied_order_id = $2,
                applied_by = $3, resolution_note = $4
          WHERE id = $1`,
        [
          filed.id,
          order.id,
          operatorLabel,
          `Assigned to this order from /admin/orphans by ${operatorLabel}.`,
        ],
      );

      return { ok: true, orderId: order.id, amountBaseUnits: settled.amountBaseUnits };
    });
  } catch (error) {
    if (error instanceof AssignConflict) return refuseAssignment(error.reason);
    throw error;
  }
}

function refuseAssignment(reason: AssignFailureReason): AssignResult {
  return { ok: false, reason, message: ASSIGN_MESSAGES[reason] };
}

// --- Discarding, from /admin/orphans -------------------------------------

export type DiscardFailureReason =
  /** No `unmatched_payments` row with this id. */
  | "not_found"
  /** The row is no longer `open` — applied, or already discarded. */
  | "already_resolved"
  /** An empty note. A discarded payment with no reason is an audit trail that says nothing. */
  | "note_required"
  | "note_too_long";

export type DiscardResult =
  | { ok: true; unmatchedId: string }
  | { ok: false; reason: DiscardFailureReason; message: string };

/**
 * How much prose one resolution note may carry.
 *
 * The column is TEXT and would take any length; this is the trust boundary,
 * not the storage limit. Long enough for "refunded 25 USDC to the fee payer,
 * tx 5Kd…, confirmed with the payer by email", short enough that a form
 * field cannot be used to write a novel into the operator's own queue.
 */
const DISCARD_NOTE_MAX = 500;

const DISCARD_MESSAGES: Record<DiscardFailureReason, string> = {
  not_found: "That filed payment no longer exists.",
  already_resolved: "That payment has already been resolved. Nothing was changed.",
  note_required: "Say what happened to the money before discarding it.",
  note_too_long: `That note is longer than ${DISCARD_NOTE_MAX} characters.`,
};

/**
 * Marks a filed payment handled, without moving anything.
 *
 * The counterpart to `settleAssignedPayment`, and deliberately its opposite in
 * every respect but one. Assignment is the rarer outcome: most stray payments
 * are somebody's mistake — a duplicate transfer, a payment for an order the
 * payer abandoned, money refunded off-chain — and the queue has no way to
 * shrink without this. Without it `/admin/orphans` could only ever grow, which
 * makes it a list nobody can work rather than a queue.
 *
 * **This settles nothing.** There is no INSERT or UPDATE against `payments`,
 * `entry_orders` or `war_tokens` anywhere in this function, and there must
 * never be one: "handled" is a statement about the operator's own workflow,
 * not about the chain, and a screen where the quiet button can also move money
 * is a screen where a mis-click moves money. The signature is likewise left
 * alone in `consumed_signatures` — discarding is not a verdict about the
 * transaction, and a payer whose refund fell through must still be able to
 * spend that signature against a live order.
 *
 * The one respect it copies exactly is the idempotency: the same
 * `FOR UPDATE` on the same `unmatched_payments` row that assignment takes as
 * its first act. A double-click, a retried POST, or an operator discarding
 * while another assigns all serialise on that lock and the loser reads the
 * true post-commit `status`, so a second request returns `already_resolved`
 * having changed nothing. And because assignment refuses any row that is not
 * `open`, a discarded row can never be assigned afterwards — the two actions
 * are mutually exclusive through one lock and one status, not through two
 * separate checks that could drift apart.
 *
 * The note is required, and required HERE rather than only in the form: an
 * operator asserting a payment was handled without saying what happened to
 * the money leaves a row that looks resolved and answers nothing. `applied_by`
 * records which operator, exactly as assignment does.
 *
 * WHO CALLS THIS: `POST /api/admin/orphans/[id]/discard`, guarded by the admin
 * session. Nothing else — `operatorLabel` is the caller asserting a human
 * authorised this, and only an authenticated route may assert it.
 */
export async function discardFiledPayment(params: {
  /** `unmatched_payments.id` — the filed payment being marked handled. */
  unmatchedId: string;
  /** What happened to the money. Required, trimmed, and capped. */
  note: string;
  /** `admin_sessions.token_label`. Never a token, never a session id. */
  operatorLabel: string;
}): Promise<DiscardResult> {
  const note = params.note.trim();
  if (!note) return refuseDiscard("note_required");
  if (note.length > DISCARD_NOTE_MAX) return refuseDiscard("note_too_long");

  return transaction(async (client): Promise<DiscardResult> => {
    // The idempotency token, locked before anything is read — the same lock,
    // on the same row, that `settleAssignedPayment` takes. See the doc above.
    const filedResult = await client.query<{ id: string; status: string }>(
      `SELECT id, status FROM unmatched_payments WHERE id = $1 FOR UPDATE`,
      [params.unmatchedId],
    );
    const filed = filedResult.rows[0];
    if (!filed) return refuseDiscard("not_found");
    if (filed.status !== "open") return refuseDiscard("already_resolved");

    // `applied_order_id` is deliberately left NULL: no order took this money.
    // 'discarded' has been in the CHECK constraint since migration 002.
    await client.query(
      `UPDATE unmatched_payments
          SET status = 'discarded', resolved_at = now(), applied_by = $2, resolution_note = $3
        WHERE id = $1`,
      [filed.id, params.operatorLabel, note],
    );

    return { ok: true, unmatchedId: filed.id };
  });
}

function refuseDiscard(reason: DiscardFailureReason): DiscardResult {
  return { ok: false, reason, message: DISCARD_MESSAGES[reason] };
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

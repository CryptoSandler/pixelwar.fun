import { query, queryOne } from "../db";
import { formatUsdc } from "./config";

/**
 * The unmatched-payment queue, read for a human.
 *
 * `unmatched_payments` is where money that reached our wallet but could not be
 * applied to a seat ends up — see `fileUnmatched`'s call sites in `settle.ts`.
 * Until this module existed the only way to look at that table was a psql
 * prompt, so a payer told to "contact support with your transaction signature"
 * was writing to somebody who could not look the signature up.
 *
 * WHO CALLS THIS: `src/app/admin/orphans/page.tsx` renders it, and
 * `GET /api/admin/orphans` returns the same rows as JSON for an operator
 * driving the surface with `x-admin-token` and no browser — the header path
 * `authenticateAdmin` exists for. Both are guarded.
 *
 * Read-only. The one act on this data that moves money — assigning a filed
 * payment to an order — is `settleAssignedPayment` in `settle.ts`, so that it
 * shares the payer's own settlement rather than growing a second one beside
 * it. Nothing in this file writes.
 */

export type Orphan = {
  id: string;
  signature: string;
  /** The order this payment was submitted against, when it named one. */
  orderId: string | null;
  /** What actually arrived, as USDC. Never base units — a human reads this. */
  receivedUsdc: string;
  /** What that order's price was, as USDC. The gap is the whole story on an underpayment. */
  expectedUsdc: string;
  reason: string;
  createdAt: Date;
  status: string;
  resolvedAt: Date | null;
  resolutionNote: string | null;
  appliedOrderId: string | null;
  /** Which operator applied it, from `admin_sessions.token_label`. Null means no human did. */
  appliedBy: string | null;
  /**
   * The fee payer the chain itself reported, when we have one. Public chain
   * data, so rendering it is fine — and it is the one fact a claimant cannot
   * forge, which is exactly what an operator reuniting a payment needs.
   */
  senderFeePayer: string | null;
  /**
   * The wallets whose USDC balance went DOWN in this transaction — whoever
   * actually funded it. Usually one; more than one means the operator should
   * look harder, not less.
   *
   * Surfaced beside the fee payer for the reason migration 002 gives when it
   * declares both: they exist so that "reuniting a stray payment from /admin
   * does not mean trusting the claimant's word for who paid it". The schema
   * anticipated this screen. Showing the signature and the amount alone would
   * leave an operator judging a money decision on exactly the facts a
   * claimant can assert.
   */
  senderDebited: { owner: string; amountUsdc: string }[];
};

type OrphanRow = {
  id: string;
  signature: string;
  order_id: string | null;
  received_base_units: string;
  expected_base_units: string;
  reason: string;
  created_at: Date;
  status: string;
  resolved_at: Date | null;
  resolution_note: string | null;
  applied_order_id: string | null;
  applied_by: string | null;
  sender_fee_payer: string | null;
  /** JSONB, as `pg` hands it back: already parsed. */
  sender_debited: { owner?: string; amountBaseUnits?: string }[] | null;
};

/**
 * How many rows the screen shows at once.
 *
 * ponytail: a flat cap, no pagination. This table takes a row only when a real
 * transfer fails to find a seat, which is rare by construction; if the queue
 * ever outgrows one screen, add a cursor on `(created_at, id)` rather than
 * raising this.
 */
export const ORPHAN_PAGE_SIZE = 200;

/**
 * Every filed payment, newest first.
 *
 * Resolved rows are included rather than hidden: `finishSettlement` closes a
 * row automatically when the same signature later settles a different order
 * (`settle.ts:736`), and an operator looking for "where did this signature go"
 * needs to see that happen. `status` is on every row so the queue and its
 * history are distinguishable at a glance.
 *
 * ponytail: `unmatched_payments_status` is `(status, created_at)` and this
 * orders across all statuses, so it is a sort rather than an index scan. At
 * this table's size that is free; if it stops being free, the fix is an index
 * on `created_at DESC`, not a query change here.
 */
export async function listOrphans(limit: number = ORPHAN_PAGE_SIZE): Promise<Orphan[]> {
  const rows = await query<OrphanRow>(
    `SELECT id, signature, order_id, received_base_units, expected_base_units, reason,
            created_at, status, resolved_at, resolution_note, applied_order_id, applied_by,
            sender_fee_payer, sender_debited
       FROM unmatched_payments
      ORDER BY created_at DESC, id DESC
      LIMIT $1`,
    [limit],
  );

  return rows.map((row) => ({
    id: row.id,
    signature: row.signature,
    orderId: row.order_id,
    // The column is TEXT holding u64 base units, because a JS number cannot
    // hold one safely. BigInt in, dollars out — the same `formatUsdc` the
    // payer's own messages use, so an operator and a payer read one number.
    receivedUsdc: formatUsdc(BigInt(row.received_base_units)),
    expectedUsdc: formatUsdc(BigInt(row.expected_base_units)),
    reason: row.reason,
    createdAt: row.created_at,
    status: row.status,
    resolvedAt: row.resolved_at,
    resolutionNote: row.resolution_note,
    appliedOrderId: row.applied_order_id,
    appliedBy: row.applied_by,
    senderFeePayer: row.sender_fee_payer,
    // Same treatment as the amounts above: base units in the column, dollars
    // on the screen. An entry with no owner is dropped rather than rendered as
    // a blank line claiming somebody paid.
    senderDebited: (row.sender_debited ?? [])
      .filter((entry): entry is { owner: string; amountBaseUnits?: string } => !!entry?.owner)
      .map((entry) => ({
        owner: entry.owner,
        amountUsdc: formatUsdc(BigInt(entry.amountBaseUnits ?? "0")),
      })),
  }));
}

export type AssignableOrder = {
  id: string;
  warTitle: string;
  ticker: string;
  colourSlot: number;
  priceUsd: number;
  status: string;
};

/**
 * Orders an operator may assign a filed payment to.
 *
 * `pending` and `expired` only: a `paid` order already holds a payment and a
 * `failed` one can never take another, and `settleAssignedPayment` refuses
 * both anyway. This query is the convenience — the refusal is the guarantee,
 * and the two are deliberately not the same mechanism. An order that becomes
 * unassignable between this list being rendered and the form being submitted
 * is caught by the settlement's own FOR UPDATE, not by this list being fresh.
 *
 * ponytail: a flat cap and no search box. A war seats at most 24 tokens, so
 * the realistic candidate set is small; if it stops being small, the answer is
 * a filter by war rather than a longer list.
 */
export async function assignableOrders(limit = 100): Promise<AssignableOrder[]> {
  const rows = await query<{
    id: string;
    war_title: string;
    ticker: string;
    colour_slot: number;
    amount_usd: number;
    status: string;
  }>(
    `SELECT o.id, w.title AS war_title, t.ticker, t.colour_slot, o.amount_usd, o.status
       FROM entry_orders o
       JOIN war_tokens t ON t.id = o.war_token_id
       JOIN wars w ON w.id = o.war_id
      WHERE o.status IN ('pending', 'expired')
      ORDER BY o.created_at DESC
      LIMIT $1`,
    [limit],
  );

  return rows.map((row) => ({
    id: row.id,
    warTitle: row.war_title,
    ticker: row.ticker,
    colourSlot: row.colour_slot,
    priceUsd: row.amount_usd,
    status: row.status,
  }));
}

/**
 * How long an unmatched payment may sit before the deployment shouts.
 *
 * A day. An unmatched payment is somebody's real money, sitting in our
 * wallet, credited to nobody — `already_settled` in particular means the
 * payer is owed a refund and does not know it. A human has to look, and a
 * threshold measured in days would be measuring how long we are comfortable
 * holding money that is not ours.
 */
export const UNMATCHED_ALERT_AGE_HOURS = 24;

export type UnmatchedBacklog = {
  /** Filed and still nobody's — neither applied nor discarded. */
  open: number;
  /** When the oldest open one was filed, or null when there are none. */
  oldestFiledAt: Date | null;
  /** Whole hours the oldest has been waiting. 0 when there are none. */
  oldestAgeHours: number;
  /** True when the oldest has waited longer than a person should take. */
  stale: boolean;
};

/**
 * The pile, rather than the flow.
 *
 * WHY THIS EXISTS AND WHAT WAS MISSING. `reconcile.yml` has warned since it
 * was written when a pass FILES something — and that is a flow measurement.
 * A payment filed on Monday produces one warning on Monday and silence
 * forever after. Nothing anywhere reported that a pile was growing, so the
 * only way to learn about an unresolved refund was for somebody to open
 * `/admin/orphans` and count, which is exactly the thing nobody does until
 * they already suspect.
 *
 * Two numbers, because they answer different questions: how many are waiting,
 * and how long the worst of them has waited. A single count says nothing
 * about urgency — ten filed this morning is a busy day, one filed a week ago
 * is a person who has been ignored.
 */
export async function unmatchedBacklog(): Promise<UnmatchedBacklog> {
  const row = await queryOne<{ open: string; oldest: Date | null }>(
    `SELECT count(*) AS open, min(created_at) AS oldest
       FROM unmatched_payments
      WHERE status = 'open'`,
  );

  const open = Number(row?.open ?? 0);
  const oldestFiledAt = row?.oldest ?? null;
  const oldestAgeHours = oldestFiledAt
    ? Math.floor((Date.now() - oldestFiledAt.getTime()) / 3_600_000)
    : 0;

  return {
    open,
    oldestFiledAt,
    oldestAgeHours,
    stale: open > 0 && oldestAgeHours >= UNMATCHED_ALERT_AGE_HOURS,
  };
}

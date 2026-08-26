import { query } from "../db";
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
 * Read-only, deliberately. Assigning a filed payment to an order is the one
 * place in this project where money would move on a human's say-so, and it is
 * NOT built here — `settlePayment` cannot be reused as-is for it. See
 * `.superpowers/sdd/2026-08-26-admin-orphans/task-2-report.md` §1.
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
  /**
   * The fee payer the chain itself reported, when we have one. Public chain
   * data, so rendering it is fine — and it is the one fact a claimant cannot
   * forge, which is exactly what an operator reuniting a payment needs.
   */
  senderFeePayer: string | null;
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
  sender_fee_payer: string | null;
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
            created_at, status, resolved_at, resolution_note, applied_order_id, sender_fee_payer
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
    senderFeePayer: row.sender_fee_payer,
  }));
}

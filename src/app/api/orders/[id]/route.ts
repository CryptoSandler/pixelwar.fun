import { queryOne } from "../../../../lib/db";
import { json, NO_STORE } from "../../../../lib/http";
import { scheduleReconcile } from "../../../../lib/payments/lazy-recovery";
import { orderById } from "../../../../lib/payments/orders";

export const dynamic = "force-dynamic";

type WarTokenRow = { ticker: string; colour_slot: number };

/**
 * The order's own status, which is what the payment screen polls every two
 * seconds while it waits (`STATUS_POLL_MS` in `PayWithWallet.tsx`).
 *
 * It is also the trigger for recovery, which is the whole of how this
 * deployment reconciles payments without a scheduler. See `lazy-recovery.ts`
 * for why the scheduler had to go; the short version is that the external
 * cron arrived hours late against a ten-minute window, and this request
 * cannot be late because it IS the payer asking.
 */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { id } = await params;

  const order = await orderById(id);
  if (!order) return json({ error: "No such order." }, { status: 404, headers: NO_STORE });

  // AFTER the response, never before it, and this is a hard requirement
  // rather than a preference: a recovery pass makes one
  // `getSignaturesForAddress` call plus up to `MAX_SIGNATURES_PER_REFERENCE`
  // `getTransaction` calls against a rate-limited endpoint, which is seconds
  // of latency on a poll that currently answers in milliseconds. `after`
  // schedules the callback to run once the response has finished, so this
  // cannot lengthen the poll by construction — not by a small amount, by
  // none — and the measurement in `lazy-recovery.test.ts` is what keeps that
  // true rather than this comment.
  //
  // The cost of that ordering, stated plainly: the pass's result is not in
  // THIS response, it is in the next poll two seconds later. That is the
  // right trade — a payer waiting two more seconds is fine, a payer whose
  // every poll takes four seconds is a broken screen — but it does mean the
  // status a caller reads here is always the status as of the pass BEFORE
  // this one.
  //
  // Nothing here can throw: `scheduleReconcile` swallows both a failing pass
  // AND a failing `after` call, which is not the same hazard twice — see its
  // own comment. A failed reconcile must never turn a healthy status poll
  // into a 500 the payer sees.
  scheduleReconcile(order, `GET /api/orders/${id}`);

  // The order's own row has everything except the ticker and colour a payer
  // is shown while they wait — those live on the war_tokens row it reserved.
  const token = await queryOne<WarTokenRow>(
    `SELECT ticker, colour_slot FROM war_tokens WHERE id = $1`,
    [order.warTokenId],
  );

  return json(
    {
      status: order.status,
      amountLamports: order.amountLamports.toString(),
      expiresAt: order.expiresAt.toISOString(),
      paidAt: order.paidAt ? order.paidAt.toISOString() : null,
      tokenTicker: token?.ticker ?? null,
      colourSlot: token?.colour_slot ?? null,
    },
    { headers: NO_STORE },
  );
}

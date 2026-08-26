import { adminConfigured, authenticateAdmin } from "../../../../lib/admin";
import { json, NO_STORE } from "../../../../lib/http";
import { listOrphans } from "../../../../lib/payments/orphans";

export const dynamic = "force-dynamic";

/**
 * The unmatched-payment queue as JSON.
 *
 * WHO CALLS THIS: an operator with no browser, driving the surface with an
 * `x-admin-token` header — the path `authenticateAdmin` documents and gates.
 * The screen at `/admin/orphans` does NOT call it: that page is a server
 * component and reads `listOrphans()` on the same request, so it is correct on
 * first paint instead of empty for a round trip. Said out loud because
 * AGENTS.md asks every new route to name its caller, and "the page fetches it"
 * would have been untrue.
 *
 * There is no POST here. Assigning a filed payment to an order — the only
 * place in this project money would move on a human's say-so — is not built,
 * because `settlePayment` cannot be reused as-is for it. See
 * `.superpowers/sdd/2026-08-26-admin-orphans/task-2-report.md` §1.
 */

/**
 * One refusal, whatever the cause.
 *
 * No cookie, an expired cookie, a revoked cookie, a junk cookie and a wrong
 * `x-admin-token` all get this exact response — status, body and headers
 * identical — so a prober cannot learn which half of the surface to attack.
 * `authenticateAdmin` already collapses all of them to `{ ok: false }`, so
 * there is nothing here to distinguish with even if it wanted to.
 *
 * An unset `ADMIN_TOKEN` gets it too. That is deliberately NOT the session
 * route's 503-for-unconfigured: this endpoint's job is to be silent about the
 * state of the surface, and "this deployment has no admin" is exactly the kind
 * of thing a prober is trying to establish. The operator learns it from the
 * server log line below instead, which is where configuration faults belong.
 */
function refuse(): Response {
  return json({ error: "Not authorised." }, { status: 401, headers: NO_STORE });
}

export async function GET(request: Request): Promise<Response> {
  if (!adminConfigured()) {
    console.error("admin/orphans: ADMIN_TOKEN is not set; refusing every request.");
    return refuse();
  }

  const identity = await authenticateAdmin(request);
  if (!identity.ok) return refuse();

  const orphans = await listOrphans();

  return json(
    {
      // Amounts are USDC strings, never base units: this is read by a human
      // deciding whether to refund real money.
      orphans: orphans.map((orphan) => ({
        id: orphan.id,
        signature: orphan.signature,
        orderId: orphan.orderId,
        receivedUsdc: orphan.receivedUsdc,
        expectedUsdc: orphan.expectedUsdc,
        reason: orphan.reason,
        createdAt: orphan.createdAt.toISOString(),
        status: orphan.status,
        resolvedAt: orphan.resolvedAt?.toISOString() ?? null,
        resolutionNote: orphan.resolutionNote,
        appliedOrderId: orphan.appliedOrderId,
        senderFeePayer: orphan.senderFeePayer,
      })),
    },
    { headers: NO_STORE },
  );
}

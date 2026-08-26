import { requireAdmin } from "../../../../../../lib/admin-guard";
import { json, NO_STORE } from "../../../../../../lib/http";
import { formatUsdc } from "../../../../../../lib/payments/config";
import { settleAssignedPayment } from "../../../../../../lib/payments/settle";

export const dynamic = "force-dynamic";

/**
 * Apply one filed payment to an order.
 *
 * **The only endpoint in this project that moves money on a human's say-so.**
 * It does not decide anything itself: it authenticates the human, reads the
 * two ids, and hands both to `settleAssignedPayment`, which is a second
 * ENTRY into the payer's own settlement rather than a second settlement —
 * same `warHasRoom`, same `reclaimReleasedSeat`, same `finishSettlement`, one
 * transaction. There is no UPDATE against `entry_orders`, `war_tokens` or
 * `payments` anywhere in this file, and there must never be one.
 *
 * WHO CALLS THIS: the form on `/admin/orphans`, one per open row. A plain HTML
 * form, so it answers a browser with a 303 back to the list and an operator's
 * script with JSON — decided by `Accept`, since a form submission and a `curl`
 * want genuinely different things and neither should have to pretend to be the
 * other.
 *
 * The operator label comes from the guard, never from the request body. A
 * caller asserting who they are is not an audit trail.
 */

/** Redirect a browser back to the list, carrying the outcome. */
function backToList(query: string): Response {
  return new Response(null, {
    status: 303,
    headers: { location: `/admin/orphans${query}`, ...NO_STORE },
  });
}

function wantsHtml(request: Request): boolean {
  return (request.headers.get("accept") ?? "").includes("text/html");
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  // Guarded before the body is so much as read: an unauthenticated request and
  // a wrong token get the identical refusal, and neither gets to learn whether
  // the id in the URL names a real row.
  const admin = await requireAdmin(request, "admin/orphans/assign");
  if (!admin.ok) return admin.response;

  const { id } = await params;

  let orderId: string;
  try {
    orderId = String((await request.formData()).get("orderId") ?? "").trim();
  } catch {
    return json({ error: "Expected a form submission." }, { status: 400, headers: NO_STORE });
  }

  if (!orderId) {
    return wantsHtml(request)
      ? backToList("?error=no_order")
      : json({ error: "An order id is required." }, { status: 400, headers: NO_STORE });
  }

  const result = await settleAssignedPayment({
    unmatchedId: id,
    orderId,
    // From the session, not from the body. `admin_sessions.token_label` is
    // what Task 1 kept for exactly this.
    operatorLabel: admin.label,
  });

  if (!result.ok) {
    // 409, not 400: every one of these means the request was well formed and
    // the state refused it. `already_resolved` — the double-click answer — is
    // among them, and is a refusal rather than an error precisely because
    // nothing was changed.
    return wantsHtml(request)
      ? backToList(`?error=${encodeURIComponent(result.reason)}`)
      : json(
          { error: result.message, reason: result.reason },
          { status: 409, headers: NO_STORE },
        );
  }

  return wantsHtml(request)
    ? backToList("?applied=1")
    : json(
        {
          ok: true,
          orderId: result.orderId,
          // USDC, never base units. An operator driving this with curl is a
          // human reading a money amount like any other.
          amountUsdc: formatUsdc(result.amountBaseUnits),
        },
        { headers: NO_STORE },
      );
}

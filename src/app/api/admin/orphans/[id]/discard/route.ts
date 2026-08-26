import { requireAdmin } from "../../../../../../lib/admin-guard";
import { json, NO_STORE } from "../../../../../../lib/http";
import { discardFiledPayment } from "../../../../../../lib/payments/settle";

export const dynamic = "force-dynamic";

/**
 * Mark one filed payment handled.
 *
 * The other half of `/admin/orphans`, and the more common one: most stray
 * payments are somebody's mistake and end in a refund, not in an assignment.
 * Without this the queue could only grow.
 *
 * **This endpoint moves nothing.** `discardFiledPayment` writes one row in
 * `unmatched_payments` and touches no other table; there is no UPDATE against
 * `entry_orders`, `war_tokens` or `payments` in this file or under it, and
 * there must never be one. What it records is the operator's own judgement,
 * with a required note saying what happened to the money — a discarded row
 * with no reason is an audit trail that says nothing.
 *
 * WHO CALLS THIS: the discard form on `/admin/orphans`, one per open row. A
 * plain HTML form, so it answers a browser with a 303 back to the list and an
 * operator's script with JSON — the same `Accept` split the assign route makes,
 * and for the same reason.
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
  const admin = await requireAdmin(request, "admin/orphans/discard");
  if (!admin.ok) return admin.response;

  const { id } = await params;

  let note: string;
  try {
    note = String((await request.formData()).get("note") ?? "");
  } catch {
    return json({ error: "Expected a form submission." }, { status: 400, headers: NO_STORE });
  }

  const result = await discardFiledPayment({
    unmatchedId: id,
    note,
    // From the session, not from the body. `admin_sessions.token_label` is
    // what Task 1 kept for exactly this.
    operatorLabel: admin.label,
  });

  if (!result.ok) {
    // A missing or oversized note is the caller's own request being wrong, so
    // 400. Everything else means the request was well formed and the state
    // refused it — 409, exactly as the assign route answers, with
    // `already_resolved` (the double-click answer) among them because nothing
    // was changed.
    const status = result.reason === "note_required" || result.reason === "note_too_long" ? 400 : 409;
    return wantsHtml(request)
      ? backToList(`?error=${encodeURIComponent(result.reason)}`)
      : json({ error: result.message, reason: result.reason }, { status, headers: NO_STORE });
  }

  return wantsHtml(request)
    ? backToList("?discarded=1")
    : json({ ok: true, discarded: result.unmatchedId }, { headers: NO_STORE });
}

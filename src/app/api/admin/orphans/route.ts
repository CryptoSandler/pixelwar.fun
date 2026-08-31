import { requireAdmin } from "../../../../lib/admin-guard";
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
 * There is no POST here: assigning a filed payment to an order lives at
 * `POST /api/admin/orphans/[id]/assign`, because it acts on one row.
 */

export async function GET(request: Request): Promise<Response> {
  // One guard, one answer — see `requireAdmin`. No cookie, a bad cookie, a
  // wrong token header and an unconfigured deployment are indistinguishable
  // from out here, on purpose.
  const admin = await requireAdmin(request, "admin/orphans");
  if (!admin.ok) return admin.response;

  const orphans = await listOrphans();

  return json(
    {
      // Amounts are SOL strings, never lamports: this is read by a human
      // deciding whether to refund real money.
      orphans: orphans.map((orphan) => ({
        id: orphan.id,
        signature: orphan.signature,
        orderId: orphan.orderId,
        receivedSol: orphan.receivedSol,
        expectedSol: orphan.expectedSol,
        reason: orphan.reason,
        createdAt: orphan.createdAt.toISOString(),
        status: orphan.status,
        resolvedAt: orphan.resolvedAt?.toISOString() ?? null,
        resolutionNote: orphan.resolutionNote,
        appliedOrderId: orphan.appliedOrderId,
        appliedBy: orphan.appliedBy,
        // Both halves of the chain's answer to "who paid this", because that
        // is what migration 002 put them there for.
        senderFeePayer: orphan.senderFeePayer,
        senderDebited: orphan.senderDebited,
      })),
    },
    { headers: NO_STORE },
  );
}

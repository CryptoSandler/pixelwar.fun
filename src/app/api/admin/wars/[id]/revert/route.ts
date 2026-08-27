import { requireAdmin } from "../../../../../../lib/admin-guard";
import { json, NO_STORE } from "../../../../../../lib/http";
import { revertRegion } from "../../../../../../lib/moderation";
import { warById } from "../../../../../../lib/wars/lifecycle";

export const dynamic = "force-dynamic";

/**
 * Clears a rectangle of the board.
 *
 * WHO CALLS THIS: the revert form in the moderation panel on `/admin/wars`.
 *
 * It CLEARS rather than restores, because nothing stores who owned a cell
 * before its current owner — see `revertRegion`. That is also what the job
 * wants: removing the drawing, not rewinding it.
 *
 * Works on a war in any status. An ended war can still be showing something
 * that has to come down, and refusing to clean a board because its clock ran
 * out would be the tool arguing with the operator.
 */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const admin = await requireAdmin(request, "admin/wars/revert");
  if (!admin.ok) return admin.response;

  const { id } = await params;
  const war = await warById(id);
  if (!war) return json({ error: "No such war." }, { status: 404, headers: NO_STORE });

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return json({ error: "Body must be JSON" }, { status: 400, headers: NO_STORE });
  }

  const { x0, y0, x1, y1 } = (body ?? {}) as Record<string, unknown>;
  if (![x0, y0, x1, y1].every((value) => typeof value === "number")) {
    return json(
      { error: "x0, y0, x1 and y1 must be numbers." },
      { status: 400, headers: NO_STORE },
    );
  }

  const result = await revertRegion({
    warId: war.id,
    width: war.width,
    height: war.height,
    x0: x0 as number,
    y0: y0 as number,
    x1: x1 as number,
    y1: y1 as number,
  });

  if (!result.ok) {
    return json({ error: result.message, reason: result.reason }, { status: 400, headers: NO_STORE });
  }

  console.warn(`admin/wars/revert: ${admin.label} cleared ${result.cleared} cells in war ${war.slug}`);
  return json({ cleared: result.cleared, seq: result.seq }, { headers: NO_STORE });
}

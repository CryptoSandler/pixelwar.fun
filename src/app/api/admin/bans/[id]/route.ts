import { requireAdmin } from "../../../../../lib/admin-guard";
import { json, NO_STORE } from "../../../../../lib/http";
import { liftBan } from "../../../../../lib/moderation";

export const dynamic = "force-dynamic";

/**
 * Lifts a ban.
 *
 * WHO CALLS THIS: the `Lift` button in the moderation panel on `/admin/wars`.
 *
 * DELETE rather than a status column: `isBanned` asks whether a row exists and
 * has not expired, so a lifted ban that stayed in the table would have to be
 * excluded by every future query that forgets to. The list keeps expired rows
 * for history; a lifted one is a decision reversed, not a record.
 */
export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const admin = await requireAdmin(request, "admin/bans/lift");
  if (!admin.ok) return admin.response;

  const { id } = await params;
  const lifted = await liftBan(id);
  if (!lifted) return json({ error: "No such ban." }, { status: 404, headers: NO_STORE });

  return json({ lifted: true }, { headers: NO_STORE });
}

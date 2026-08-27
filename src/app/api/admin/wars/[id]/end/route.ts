import { requireAdmin } from "../../../../../../lib/admin-guard";
import { json, NO_STORE } from "../../../../../../lib/http";
import { endWarNow } from "../../../../../../lib/moderation";
import { warById } from "../../../../../../lib/wars/lifecycle";

export const dynamic = "force-dynamic";

/**
 * The kill switch: ends a live war immediately.
 *
 * WHO CALLS THIS: the `End now` control in the moderation panel on
 * `/admin/wars`, behind a typed confirmation.
 *
 * MODERATION, NOT LIFECYCLE, and the distinction is why it ships in this
 * batch while creating and scheduling wars waits for a later one. Reverting a
 * region assumes the board is worth keeping. When it is not — when what is on
 * screen is the reason the site has to come down — the operator needs one
 * action that stops every further paint at once, and `paintPixel` refuses any
 * war that is not `live`.
 *
 * 409 rather than 404 for a war that was not live: the war exists, the action
 * does not apply to it, and a double-click deserves that answer rather than
 * "no such war".
 */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const admin = await requireAdmin(request, "admin/wars/end");
  if (!admin.ok) return admin.response;

  const { id } = await params;
  const war = await warById(id);
  if (!war) return json({ error: "No such war." }, { status: 404, headers: NO_STORE });

  const ended = await endWarNow(war.id);
  if (!ended) {
    return json(
      { error: `That war is ${war.status}, not live.` },
      { status: 409, headers: NO_STORE },
    );
  }

  console.warn(`admin/wars/end: ${admin.label} ended war ${war.slug} immediately`);
  return json({ ended: true }, { headers: NO_STORE });
}

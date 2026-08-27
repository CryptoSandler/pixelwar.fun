import { requireAdmin } from "../../../../../../lib/admin-guard";
import { json, NO_STORE } from "../../../../../../lib/http";
import { inspectPixel } from "../../../../../../lib/moderation";
import { warById } from "../../../../../../lib/wars/lifecycle";

export const dynamic = "force-dynamic";

/**
 * Everything recorded about one cell.
 *
 * WHO CALLS THIS: the pixel inspector in the moderation panel on
 * `/admin/wars`, which is how an operator gets from "that region is a
 * problem" to a key they can ban.
 *
 * WHAT IT CANNOT ANSWER, and says so rather than implying otherwise:
 * `pixel_events` has never carried `painter_key` or `ip_hash`. Only `pixels`
 * does, and only for the painter holding the cell right now. So an
 * overpainted cell yields a real timeline and exactly one bannable painter.
 * `earlierPaintersUnavailable` is that fact as a field, so the screen can put
 * it in front of the operator instead of letting them assume the list is
 * complete.
 */
export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const admin = await requireAdmin(request, "admin/wars/pixel");
  if (!admin.ok) return admin.response;

  const { id } = await params;
  const war = await warById(id);
  if (!war) return json({ error: "No such war." }, { status: 404, headers: NO_STORE });

  const search = new URL(request.url).searchParams;
  const x = Number(search.get("x"));
  const y = Number(search.get("y"));
  if (
    !Number.isInteger(x) ||
    !Number.isInteger(y) ||
    x < 0 ||
    y < 0 ||
    x >= war.width ||
    y >= war.height
  ) {
    return json({ error: "That pixel is not on the board." }, { status: 400, headers: NO_STORE });
  }

  const pixel = await inspectPixel(war.id, x, y, war.width);

  return json(
    {
      x: pixel.x,
      y: pixel.y,
      current: pixel.current
        ? {
            warTokenId: pixel.current.warTokenId,
            ticker: pixel.current.ticker,
            colourSlot: pixel.current.colourSlot,
            paintedAt: pixel.current.paintedAt.toISOString(),
            // Both are already hashes — `client-ip.ts` salts and hashes before
            // anything reaches the database, so no raw address exists to leak.
            painterKey: pixel.current.painterKey,
            ipHash: pixel.current.ipHash,
            // Not hashed, because it is a public key: it is on chain, it is
            // in every transaction this painter signed, and hashing it would
            // make the one key that can be banned unbannable.
            wallet: pixel.current.wallet,
          }
        : null,
      timeline: pixel.timeline.map((event) => ({
        seq: event.seq,
        colourSlot: event.colourSlot,
        ticker: event.ticker,
        paintedAt: event.paintedAt.toISOString(),
      })),
      earlierPaintersUnavailable: pixel.earlierPaintersUnavailable,
    },
    { headers: NO_STORE },
  );
}

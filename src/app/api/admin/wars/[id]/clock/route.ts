import { requireAdmin } from "../../../../../../lib/admin-guard";
import { json, NO_STORE } from "../../../../../../lib/http";
import { extendWar, moveStart } from "../../../../../../lib/wars/operate";

export const dynamic = "force-dynamic";

/**
 * Moves one of a war's two clocks.
 *
 * WHO CALLS THIS: the clock controls on `/admin/wars` — "start now", "open
 * at", and "extend".
 *
 * ONE ROUTE FOR BOTH CLOCKS because from the operator's side they are the
 * same kind of act, and splitting them into two endpoints would mean two
 * guards, two shapes and two places to forget something. `which` says which
 * clock; the module behind it owns what each one is allowed to do.
 *
 * The status is never in the body. `advanceWar` decides status from the
 * clocks, and an endpoint that accepted one would be offering the operator a
 * way to contradict the state machine.
 */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const admin = await requireAdmin(request, "admin/wars/clock");
  if (!admin.ok) return admin.response;

  const { id } = await params;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return json({ error: "Body must be JSON" }, { status: 400, headers: NO_STORE });
  }

  const { which, at } = (body ?? {}) as Record<string, unknown>;
  if ((which !== "start" && which !== "end") || typeof at !== "string") {
    return json(
      { error: 'which must be "start" or "end", and at must be a timestamp.' },
      { status: 400, headers: NO_STORE },
    );
  }

  const when = new Date(at);
  if (Number.isNaN(when.getTime())) {
    return json({ error: "at must be a timestamp." }, { status: 400, headers: NO_STORE });
  }

  const result = which === "start" ? await moveStart(id, when) : await extendWar(id, when);

  if (!result.ok) {
    return json(
      { error: result.message, reason: result.reason },
      { status: result.reason === "no_such_war" ? 404 : 409, headers: NO_STORE },
    );
  }

  console.warn(
    `admin/wars/clock: ${admin.label} moved ${which} of ${result.value.slug} to ${when.toISOString()}`,
  );
  return json(
    {
      slug: result.value.slug,
      status: result.value.status,
      startsAt: result.value.startsAt.toISOString(),
      endsAt: result.value.endsAt.toISOString(),
    },
    { headers: NO_STORE },
  );
}

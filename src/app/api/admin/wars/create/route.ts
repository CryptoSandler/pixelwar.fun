import { requireAdmin } from "../../../../../lib/admin-guard";
import { json, NO_STORE } from "../../../../../lib/http";
import { createWar } from "../../../../../lib/wars/operate";

export const dynamic = "force-dynamic";

/**
 * Opens a war.
 *
 * WHO CALLS THIS: the create form on `/admin/wars`.
 *
 * Until this existed the only way a war came into being was
 * `scripts/seed-war.mts`, which meant running an event required a developer
 * at a terminal. That script stays as a development tool; it is no longer
 * the only door.
 */
export async function POST(request: Request): Promise<Response> {
  const admin = await requireAdmin(request, "admin/wars/create");
  if (!admin.ok) return admin.response;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return json({ error: "Body must be JSON" }, { status: 400, headers: NO_STORE });
  }

  const { slug, title, entryPriceUsd, cooldownSeconds, startsAt, endsAt, maxTokens } =
    (body ?? {}) as Record<string, unknown>;

  if (
    typeof slug !== "string" ||
    typeof title !== "string" ||
    typeof entryPriceUsd !== "number" ||
    typeof cooldownSeconds !== "number" ||
    typeof startsAt !== "string" ||
    typeof endsAt !== "string"
  ) {
    return json(
      {
        error:
          "slug, title, startsAt and endsAt are strings; entryPriceUsd and cooldownSeconds are numbers.",
      },
      { status: 400, headers: NO_STORE },
    );
  }

  const opens = new Date(startsAt);
  const closes = new Date(endsAt);
  if (Number.isNaN(opens.getTime()) || Number.isNaN(closes.getTime())) {
    return json(
      { error: "startsAt and endsAt must be timestamps." },
      { status: 400, headers: NO_STORE },
    );
  }

  const result = await createWar({
    slug,
    title,
    entryPriceUsd,
    cooldownSeconds,
    startsAt: opens,
    endsAt: closes,
    maxTokens: typeof maxTokens === "number" ? maxTokens : undefined,
  });

  if (!result.ok) {
    return json({ error: result.message, reason: result.reason }, { status: 400, headers: NO_STORE });
  }

  console.warn(`admin/wars/create: ${admin.label} opened ${result.value.slug}`);
  return json(
    { id: result.value.id, slug: result.value.slug, status: result.value.status },
    { headers: NO_STORE },
  );
}

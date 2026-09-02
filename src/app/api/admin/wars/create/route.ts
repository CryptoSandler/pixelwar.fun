import { LAMPORTS_PER_SOL } from "../../../../../lib/payments/config";
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

  const { slug, title, entryPriceSol, cooldownSeconds, startsAt, endsAt, maxTokens, width, height } =
    (body ?? {}) as Record<string, unknown>;

  if (
    typeof slug !== "string" ||
    typeof title !== "string" ||
    typeof entryPriceSol !== "number" ||
    !Number.isFinite(entryPriceSol) ||
    entryPriceSol <= 0 ||
    typeof cooldownSeconds !== "number" ||
    typeof startsAt !== "string" ||
    typeof endsAt !== "string"
  ) {
    return json(
      {
        error:
          "slug, title, startsAt and endsAt are strings; entryPriceSol and cooldownSeconds are numbers.",
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
    // SOL in, lamports stored. Rounded to whole lamports here, at the one
    // place an operator's decimal becomes a number the chain can move.
    entryPriceLamports: BigInt(Math.round(entryPriceSol * Number(LAMPORTS_PER_SOL))),
    cooldownSeconds,
    startsAt: opens,
    endsAt: closes,
    maxTokens: typeof maxTokens === "number" ? maxTokens : undefined,
    // Board size, optional and defaulted by `createWar`. Passed through
    // rather than validated here, for the reason the paint route gives about
    // `colourSlot`: the bound belongs at the boundary that touches the
    // database, and a second copy of it here is a second thing to keep in
    // step. `createWar` refuses out-of-range sides by name, and migration
    // 018's CHECK is what makes the bound true of rows this route never saw.
    width: typeof width === "number" ? width : undefined,
    height: typeof height === "number" ? height : undefined,
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

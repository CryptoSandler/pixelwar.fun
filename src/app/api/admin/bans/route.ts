import { requireAdmin } from "../../../../lib/admin-guard";
import { json, NO_STORE } from "../../../../lib/http";
import { banKey, listBans, type BanKeyType } from "../../../../lib/moderation";

export const dynamic = "force-dynamic";

const KEY_TYPES: BanKeyType[] = ["painter", "ip", "subnet"];

/**
 * The ban list.
 *
 * WHO CALLS THIS: the moderation panel on `/admin/wars`, which reads the list
 * server-side on the same request and posts here to add one. Named because
 * AGENTS.md asks it of every route, and because this repo has shipped
 * finished, reviewed functions that nothing called.
 */
export async function GET(request: Request): Promise<Response> {
  const admin = await requireAdmin(request, "admin/bans");
  if (!admin.ok) return admin.response;

  const bans = await listBans();
  return json(
    {
      bans: bans.map((ban) => ({
        id: ban.id,
        keyType: ban.keyType,
        key: ban.key,
        reason: ban.reason,
        actor: ban.actor,
        live: ban.live,
        createdAt: ban.createdAt.toISOString(),
        expiresAt: ban.expiresAt?.toISOString() ?? null,
      })),
    },
    { headers: NO_STORE },
  );
}

/**
 * Bans a key, or extends an existing ban.
 *
 * `expiresAt` is required in the body and may be explicitly `null`, rather
 * than being optional with a default. A ban with no end is an irreversible
 * sentence and this endpoint will not write one by omission — the caller has
 * to say so. The default the UI offers is a fixed term; the policy is
 * recorded in `docs/operations.md` as an open decision.
 */
export async function POST(request: Request): Promise<Response> {
  const admin = await requireAdmin(request, "admin/bans");
  if (!admin.ok) return admin.response;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return json({ error: "Body must be JSON" }, { status: 400, headers: NO_STORE });
  }

  const { keyType, key, reason, expiresAt } = (body ?? {}) as Record<string, unknown>;

  if (typeof keyType !== "string" || !KEY_TYPES.includes(keyType as BanKeyType)) {
    return json(
      { error: `keyType must be one of ${KEY_TYPES.join(", ")}.` },
      { status: 400, headers: NO_STORE },
    );
  }
  if (typeof key !== "string" || key.trim() === "") {
    return json({ error: "key is required." }, { status: 400, headers: NO_STORE });
  }
  // Present-and-null is a decision; absent is an omission. Only the first is
  // allowed to produce a ban that never ends.
  if (!(expiresAt === null || typeof expiresAt === "string")) {
    return json(
      { error: "expiresAt must be an ISO timestamp, or null for no expiry." },
      { status: 400, headers: NO_STORE },
    );
  }

  let expiry: Date | null = null;
  if (typeof expiresAt === "string") {
    const parsed = new Date(expiresAt);
    if (Number.isNaN(parsed.getTime())) {
      return json({ error: "expiresAt is not a valid timestamp." }, { status: 400, headers: NO_STORE });
    }
    expiry = parsed;
  }

  const ban = await banKey({
    keyType: keyType as BanKeyType,
    key: key.trim(),
    reason: typeof reason === "string" && reason.trim() !== "" ? reason.trim() : null,
    // The operator's label, never the secret — `admin_sessions` stores a name
    // for exactly this reason.
    actor: admin.label,
    expiresAt: expiry,
  });

  return json(
    {
      id: ban.id,
      keyType: ban.keyType,
      key: ban.key,
      expiresAt: ban.expiresAt?.toISOString() ?? null,
    },
    { headers: NO_STORE },
  );
}

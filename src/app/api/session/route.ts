import { identify, json, NO_STORE } from "../../../lib/http";
import { queryOne } from "../../../lib/db";
import { currentWar } from "../../../lib/wars/lifecycle";

export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
  const caller = identify(request);
  if (!caller.ok) return json({ error: caller.message }, { status: 400, headers: NO_STORE });

  const war = await currentWar();
  let cooldownUntil: string | null = null;

  if (war) {
    const row = await queryOne<{ until: Date }>(
      `SELECT last_painted_at + ($3 || ' seconds')::interval AS until
         FROM paint_cooldowns
        WHERE war_id = $1 AND key_type = 'painter' AND key = $2`,
      [war.id, caller.painterKey, String(war.cooldownSeconds)],
    );
    if (row && row.until.getTime() > Date.now()) cooldownUntil = row.until.toISOString();
  }

  return json(
    { cooldownUntil },
    { headers: { ...NO_STORE, ...(caller.setCookie ? { "set-cookie": caller.setCookie } : {}) } },
  );
}

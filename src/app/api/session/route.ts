import { identify, json, NO_STORE } from "../../../lib/http";
import { queryOne } from "../../../lib/db";
import { allegianceOf } from "../../../lib/paint/allegiance";
import { currentWar } from "../../../lib/wars/lifecycle";

export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
  const caller = identify(request);
  if (!caller.ok) return json({ error: caller.message }, { status: 400, headers: NO_STORE });

  const war = await currentWar();
  let cooldownUntil: string | null = null;
  /**
   * Which side this painter is on, if they have painted here before.
   *
   * Answered on the request that already identifies the painter rather than
   * on one of its own: the cookie is read here, the war is loaded here, and a
   * second endpoint would repeat both to return one row. The swear control
   * needs it before the painter does anything, which is exactly when this
   * call is already in flight.
   */
  let allegiance: { warTokenId: string; ticker: string | null; sworn: boolean } | null = null;

  if (war) {
    const side = await allegianceOf(war.id, caller.painterKey);
    if (side) {
      allegiance = {
        warTokenId: side.warTokenId,
        ticker: side.ticker,
        // The wallet itself is deliberately NOT returned. The screen needs to
        // know whether this painter is sworn, not which wallet did it — and
        // an endpoint that hands back a wallet address on a cookie is one
        // more place an address can leak from.
        sworn: side.wallet !== null,
      };
    }

    const row = await queryOne<{ until: Date }>(
      `SELECT last_painted_at + ($3 || ' seconds')::interval AS until
         FROM paint_cooldowns
        WHERE war_id = $1 AND key_type = 'painter' AND key = $2`,
      [war.id, caller.painterKey, String(war.cooldownSeconds)],
    );
    if (row && row.until.getTime() > Date.now()) cooldownUntil = row.until.toISOString();
  }

  return json(
    { cooldownUntil, allegiance },
    { headers: { ...NO_STORE, ...(caller.setCookie ? { "set-cookie": caller.setCookie } : {}) } },
  );
}

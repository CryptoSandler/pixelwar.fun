import { identify, json, NO_STORE } from "../../../lib/http";
import { queryOne } from "../../../lib/db";
import { allegianceOf } from "../../../lib/paint/allegiance";
import { linkedWallet, registrationCost } from "../../../lib/paint/registration";
import { currentWar } from "../../../lib/wars/lifecycle";

export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
  const caller = identify(request);
  if (!caller.ok) return json({ error: caller.message }, { status: 400, headers: NO_STORE });

  /**
   * Whether this browser may paint, and what registering costs if not.
   *
   * ANSWERED WHETHER OR NOT A WAR IS RUNNING, unlike everything else here: a
   * registration is not per-war, and the intermission is a perfectly good
   * moment to get set up for the next one.
   *
   * THE WALLET IS RETURNED HERE AND DELIBERATELY NOT BELOW, which is a real
   * difference and not an inconsistency. `sworn` is a badge — the screen
   * needs the fact, never the address. This one is an identity the person is
   * currently acting as, and the screen compares it against the wallet the
   * browser has connected: without it, somebody linked to a wallet they no
   * longer use has no way to see that, and re-linking is exactly the fix
   * they cannot find.
   */
  const wallet = await linkedWallet(caller.painterKey);
  const cost = registrationCost();

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
    {
      cooldownUntil,
      allegiance,
      registration: {
        wallet,
        feeLamports: cost.lamports.toString(),
        free: cost.free,
      },
    },
    { headers: { ...NO_STORE, ...(caller.setCookie ? { "set-cookie": caller.setCookie } : {}) } },
  );
}

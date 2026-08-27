import type { PoolClient } from "pg";

/**
 * Checked before anything is written, so a banned caller leaves no row behind —
 * not a pixel, not a cooldown, not an event. An attempt that records something
 * is an attempt that tells the attacker they exist.
 *
 * THE WALLET IS RESOLVED AS A SUBQUERY, not as a second round trip, and that
 * is a measured decision rather than a stylistic one. This runs inside the
 * paint transaction, and the load test showed the war's write ceiling is set
 * by round trips held under the `last_seq` row lock (docs/operations.md).
 * This check happens BEFORE that lock is taken, so it costs nothing there —
 * but a caller who added a separate lookup would be one step from moving it
 * later and paying for it under the lock.
 *
 * The wallet key is the only one of the four that cannot be shed. A painter
 * key is a cookie and an address rotates; a wallet is bound either by
 * `war_painters_wallet`, where getting another costs another token purchase,
 * or by `painter_wallets`, where getting another costs another registration
 * fee. Both are looked at, because they are different wallets on the same
 * person: a sworn holder's wallet need not be the one that registered.
 *
 * The UNION rather than two subqueries because a ban on either is a ban. It
 * still costs one round trip and it still happens before the lock.
 */
export async function isBanned(
  client: PoolClient,
  keys: { warId: string; painterKey: string; ipHash: string; subnetKey: string },
): Promise<boolean> {
  const result = await client.query(
    `SELECT 1 FROM bans
      WHERE (expires_at IS NULL OR expires_at > now())
        AND ( (key_type = 'painter' AND key = $1)
           OR (key_type = 'ip'      AND key = $2)
           OR (key_type = 'subnet'  AND key = $3)
           OR (key_type = 'wallet'  AND key IN (
                 SELECT wallet FROM war_painters
                  WHERE war_id = $4 AND painter_key = $1 AND wallet IS NOT NULL
                 UNION
                 SELECT wallet FROM painter_wallets
                  WHERE painter_key = $1
               )) )
      LIMIT 1`,
    [keys.painterKey, keys.ipHash, keys.subnetKey, keys.warId],
  );
  return (result.rowCount ?? 0) > 0;
}

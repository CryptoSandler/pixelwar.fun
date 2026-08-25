import type { PoolClient } from "pg";

/**
 * Checked before anything is written, so a banned caller leaves no row behind —
 * not a pixel, not a cooldown, not an event. An attempt that records something
 * is an attempt that tells the attacker they exist.
 */
export async function isBanned(
  client: PoolClient,
  keys: { painterKey: string; ipHash: string; subnetKey: string },
): Promise<boolean> {
  const result = await client.query(
    `SELECT 1 FROM bans
      WHERE (expires_at IS NULL OR expires_at > now())
        AND ( (key_type = 'painter' AND key = $1)
           OR (key_type = 'ip'      AND key = $2)
           OR (key_type = 'subnet'  AND key = $3) )
      LIMIT 1`,
    [keys.painterKey, keys.ipHash, keys.subnetKey],
  );
  return (result.rowCount ?? 0) > 0;
}

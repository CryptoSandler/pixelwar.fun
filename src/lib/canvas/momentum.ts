import { execute, query } from "../db";

/**
 * Which way the board is moving, per token, right now.
 *
 * THE PURPOSE IS THE LOSING SIDE. A scoreboard tells a community it is
 * behind; it does not tell them they are being taken apart this minute, which
 * is the thing that brings people back to defend. r/place armies learned this
 * from Discord and a human shouting; the sidebar can say it by itself.
 *
 * HOW IT IS MEASURED, AND WHY IT IS NOT MEASURED FROM THE EVENT LOG. The
 * obvious implementation reads `pixel_events` and compares each paint with
 * the previous paint on the same cell. It was written that way first, and it
 * did not work: Postgres applies WHERE before window functions, so a
 * ten-minute filter meant `lag()` only ever saw rows already inside the
 * window — and a raid overpaints cells somebody claimed HOURS ago, so the
 * victim had no row in the window and was charged nothing. Measured against a
 * seeded board where 216 pixels changed hands, it reported zero losses for
 * anybody and credited a token +20 for retouching its own old art.
 *
 * Fixing that from the event log needs indexes on `(war_id, painted_at)` and
 * `(war_id, idx, seq)` — two more b-trees maintained inside the paint
 * transaction, which `docs/operations.md` measures a per-war paints-per-second
 * ceiling for and which is serialised on a row lock. A display signal does
 * not get to make the write path slower.
 *
 * So this diffs a number the paint path already maintains transactionally:
 * `token_pixel_counts.owned`. Momentum is `owned` now minus `owned` at a
 * snapshot taken about ten minutes ago. Exact by construction, and the write
 * costs one upsert a minute rather than anything per paint.
 */

/** How far back the signal looks. */
export const MOMENTUM_MINUTES = 10;

/**
 * How often a snapshot is taken, at most.
 *
 * The window is ten minutes and the resolution is one, so the reported figure
 * covers somewhere between ten and eleven minutes rather than exactly ten.
 * That slack is deliberate and is not worth spending writes to remove: this
 * number's job is "you are losing ground fast", and nobody reading it can
 * tell — or should care about — the difference between the two.
 */
export const SNAPSHOT_EVERY_SECONDS = 60;

/**
 * How stale a snapshot may be before the signal refuses to report at all.
 *
 * Snapshots are written lazily, on the leaderboard read, so a war nobody
 * watched for an hour has none in the window. Diffing against a two-hour-old
 * snapshot and labelling it "the last ten minutes" would be the application
 * lying about itself, and a wrong number nobody can detect is worse than no
 * number — the same reasoning `cluster.ts` blocks a signature on.
 */
export const MOMENTUM_MAX_SNAPSHOT_MINUTES = 25;

/** How long snapshots are kept. Nothing reads one older than the window. */
export const SNAPSHOT_RETENTION_HOURS = 6;

export type Momentum = { warTokenId: string; net: number };

/**
 * Records where every token stands, at most once a minute per war.
 *
 * LAZY, ON THE READ PATH, AND THAT IS THIS REPOSITORY'S OWN PATTERN rather
 * than a shortcut. `expireStaleOrders` is called by `freeColours` and
 * `createOrder` "so no route can forget to"; `advanceWar` runs on every read
 * of a war for the same reason. The alternative here was the reconcile cron,
 * and it cannot do this job: it runs hourly, and an hourly snapshot cannot
 * answer a question about the last ten minutes.
 *
 * It also lands exactly where it is needed. Snapshots are only worth taking
 * while somebody is watching the board, and the leaderboard poll IS somebody
 * watching the board.
 *
 * ONE STATEMENT, so two concurrent polls cannot both find no recent snapshot
 * and both write. The `NOT EXISTS` is evaluated inside the INSERT rather than
 * as a separate SELECT; a duplicate would be harmless anyway — two snapshots
 * a second apart give the same answer — but a race that writes 24 extra rows
 * on every poll of a busy war is not harmless.
 */
export async function snapshotTokenCounts(warId: string): Promise<void> {
  await execute(
    `INSERT INTO token_pixel_snapshots (war_id, war_token_id, owned, removed_by_moderation)
     SELECT c.war_id, c.war_token_id, c.owned, c.removed_by_moderation
       FROM token_pixel_counts c
      WHERE c.war_id = $1
        AND NOT EXISTS (
          SELECT 1 FROM token_pixel_snapshots s
           WHERE s.war_id = c.war_id
             AND s.taken_at > now() - ($2 || ' seconds')::interval
        )`,
    [warId, String(SNAPSHOT_EVERY_SECONDS)],
  );
}

/**
 * Pixels each token has gained or lost in the last `MOMENTUM_MINUTES`.
 *
 * MODERATION IS ADDED BACK, and this is the whole reason
 * `removed_by_moderation` exists. `revertRegion` decrements `owned` when it
 * clears vandalism, so a raw diff would charge a community a loss for having
 * its own graffiti removed — and would put a moderator's action on a public
 * scoreboard, which is the one thing the board-signal work was careful never
 * to do. Subtracting the removals that happened in the same interval leaves
 * only ground that changed hands between communities.
 *
 * A TOKEN WITH NO SNAPSHOT IN RANGE IS OMITTED, not reported as zero. Zero
 * means "nothing moved"; missing means "not known", and the row renders
 * nothing at all rather than a quiet claim that a raid is not happening.
 */
export async function territoryMomentum(warId: string): Promise<Map<string, Momentum>> {
  const rows = await query<{ war_token_id: string; net: string }>(
    `SELECT c.war_token_id,
            -- The pixels moderation took are not a loss to a rival, so they
            -- come back out of the difference.
            (c.owned - s.owned) + (c.removed_by_moderation - s.removed_by_moderation) AS net
       FROM token_pixel_counts c
       JOIN LATERAL (
         SELECT owned, removed_by_moderation
           FROM token_pixel_snapshots s
          WHERE s.war_id = c.war_id
            AND s.war_token_id = c.war_token_id
            AND s.taken_at <= now() - ($2 || ' minutes')::interval
            AND s.taken_at >= now() - ($3 || ' minutes')::interval
          ORDER BY s.taken_at DESC
          LIMIT 1
       ) s ON true
      WHERE c.war_id = $1`,
    [warId, String(MOMENTUM_MINUTES), String(MOMENTUM_MAX_SNAPSHOT_MINUTES)],
  );

  const out = new Map<string, Momentum>();
  for (const row of rows) {
    out.set(row.war_token_id, { warTokenId: row.war_token_id, net: Number(row.net) });
  }
  return out;
}

/**
 * Drops snapshots nothing can read any more.
 *
 * Housekeeping, hung on the reconcile sweep for the reason `pruneOathNonces`
 * is: it is the one thing in this project that already runs on a schedule,
 * and a table that only grows is a slow leak rather than a breach — which is
 * precisely why it needs an owner rather than an intention. A 72-hour war
 * with 24 tokens writes about 104,000 of these; without a sweep they stay
 * for the life of the database.
 *
 * The retention is hours rather than minutes so a reader can still be served
 * during an outage of whatever is doing the pruning.
 */
export async function pruneTokenSnapshots(): Promise<number> {
  return execute(
    `DELETE FROM token_pixel_snapshots
      WHERE taken_at < now() - ($1 || ' hours')::interval`,
    [String(SNAPSHOT_RETENTION_HOURS)],
  );
}

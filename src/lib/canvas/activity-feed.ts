import { query } from "../db";
import { toActivityEvents, type ActivityEvent } from "./standings";

/**
 * What is happening on this board, right now, as a list of events.
 *
 * WHY THIS NEEDED NO MIGRATION. `pixel_events` has carried `idx`,
 * `colour_slot` and `painted_at` since migration 001, and gained
 * `war_token_id` in 007 when attribution was decoupled from colour. Every
 * column the feed reads was already being written on every paint — the data
 * to show a board being fought over has existed for the whole life of the
 * project and nothing looked at it.
 *
 * THE ARITHMETIC IS NOT HERE. `toActivityEvents` and `leaderOf` live in
 * `standings.ts` because the browser needs them and this file cannot cross:
 * it imports `db`, which imports `pg`. Borrowing one function from here
 * dragged `dns`, `fs`, `net` and `tls` into the client bundle and Turbopack
 * refused to build it — the same trade `signature.ts` was split out for.
 *
 * WHAT IT IS FOR. A visitor arriving at a canvas has to answer "is anything
 * happening here" in about two seconds, and a still image cannot. The board
 * updates every 1.5s, but a single pixel changing 200x200 pixels away is
 * invisible; the feed is where those changes become legible as activity
 * rather than as noise.
 */

/**
 * The most recent paints, newest first.
 *
 * DELIBERATELY NOT `SELECT *` FROM A JOIN PER ROW. One query, bounded by
 * `limit`, ordered by the sequence the board already uses — `seq` is
 * monotonic and gapless (migration 001), so ordering by it is ordering by
 * what actually happened rather than by a timestamp two rows can share.
 *
 * A cleared cell (`colour_slot = 0`, no token — what `revertRegion` writes)
 * is EXCLUDED. The feed answers "who is painting", and a moderator clearing
 * a region is not somebody painting; showing it would put an operator's
 * action in a list of players' actions, and the one time that matters is
 * exactly when a region has just been cleared for being vile.
 */
export async function recentActivity(
  warId: string,
  width: number,
  limit = 12,
): Promise<ActivityEvent[]> {
  const rows = await query<{
    seq: string;
    idx: number;
    colour_slot: number;
    ticker: string | null;
    painted_at: Date;
  }>(
    `SELECT e.seq, e.idx, e.colour_slot, t.ticker, e.painted_at
       FROM pixel_events e
       JOIN war_tokens t ON t.id = e.war_token_id
      WHERE e.war_id = $1 AND e.war_token_id IS NOT NULL
      ORDER BY e.seq DESC
      LIMIT $2`,
    [warId, limit],
  );

  return toActivityEvents(rows, width);
}

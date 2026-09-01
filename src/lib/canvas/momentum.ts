import { query } from "../db";

/**
 * Which way the board is moving, per token, right now.
 *
 * THE PURPOSE IS THE LOSING SIDE. A scoreboard tells a community it is
 * behind; it does not tell them they are being taken apart this minute, which
 * is the thing that brings people back to defend. r/place armies learned this
 * from Discord and a human shouting; the rail can say it by itself.
 *
 * WHAT IT COUNTS, EXACTLY, because the honest name for it is narrower than
 * "territory lost": pixels that CHANGED HANDS inside the window this reads.
 * A pixel is a loss for the token that held it and a gain for the one that
 * took it, and both are known only when the previous owner's own event is
 * also inside the window.
 *
 * A TOKEN REPAINTING ITS OWN CELL IS NEITHER, and that is the one thing the
 * arithmetic has to be told rather than deriving. Counting every event as a
 * gain — which is what "count the rows and group by token" does — makes a
 * community tidying its own art the fastest-rising number on the board, so
 * the signal would fire hardest for whoever is under the least pressure.
 * `gains` therefore filters on the previous owner, exactly as `losses` does.
 *
 * WHAT IT THEREFORE MISSES: a pixel taken from a token whose last event on
 * that cell is older than the window is counted as a gain for the taker and
 * NOT as a loss for the holder. On a busy board — a raid overpainting the
 * same cells, which is the case this exists for — the miss is small. On a
 * quiet board it reports close to nothing, which is also the truth of that
 * moment.
 *
 * WHY IT IS NOT EXACT: exactness needs the previous owner on the event row,
 * which is a column and a migration. The owner asked for no schema, so this
 * is a signal and is labelled as one — the same standing `abuse.ts` has.
 *
 * WHAT IT COSTS, and this is the part the write ceiling makes matter
 * (operations.md): one bounded range scan on the `(war_id, seq)` primary key,
 * never a full history read. The window is `MOMENTUM_EVENTS` rows at most, so
 * the query's cost does not grow with the length of the war.
 */

/** How far back the signal looks. */
export const MOMENTUM_MINUTES = 10;

/**
 * The most events one read will consider, newest first.
 *
 * A ceiling on the QUERY, not on the truth: at the projected 40 paints per
 * second a ten-minute window can hold 24,000 events, and reading them on a
 * two-second poll would put the leaderboard in the same serialised path the
 * paint transaction fights for. Five thousand is a fifth of the worst case
 * and the signal it produces — "you are losing ground fast" — does not get
 * more true with more rows.
 */
export const MOMENTUM_EVENTS = 5_000;

export type Momentum = { warTokenId: string; gained: number; lost: number; net: number };

export async function territoryMomentum(warId: string): Promise<Map<string, Momentum>> {
  const rows = await query<{ token: string; gained: string; lost: string }>(
    `WITH recent AS (
       SELECT idx, seq, war_token_id, painted_at
         FROM pixel_events
        WHERE war_id = $1
          -- Moderation cleanup is not somebody losing a fight. The same
          -- predicate the activity feed uses, for the same reason.
          AND war_token_id IS NOT NULL
        ORDER BY seq DESC
        LIMIT $2
     ),
     windowed AS (
       SELECT idx, seq, war_token_id,
              lag(war_token_id) OVER (PARTITION BY idx ORDER BY seq) AS previous
         FROM recent
        WHERE painted_at > now() - ($3 || ' minutes')::interval
     ),
     gains AS (
       -- IS DISTINCT FROM, not <>, and the NULL case is the whole reason.
       -- A NULL previous means this token's own last event on this cell is
       -- older than the window (or there was none at all) — it took ground it
       -- was not already holding, which is a gain. A previous equal to itself
       -- is a community retouching its own art, which is not.
       SELECT war_token_id AS token, count(*) AS n
         FROM windowed
        WHERE previous IS DISTINCT FROM war_token_id
        GROUP BY war_token_id
     ),
     losses AS (
       SELECT previous AS token, count(*) AS n
         FROM windowed
        WHERE previous IS NOT NULL AND previous <> war_token_id
        GROUP BY previous
     )
     SELECT COALESCE(g.token, l.token) AS token,
            COALESCE(g.n, 0) AS gained,
            COALESCE(l.n, 0) AS lost
       FROM gains g FULL OUTER JOIN losses l ON l.token = g.token`,
    [warId, MOMENTUM_EVENTS, String(MOMENTUM_MINUTES)],
  );

  const out = new Map<string, Momentum>();
  for (const row of rows) {
    const gained = Number(row.gained);
    const lost = Number(row.lost);
    out.set(row.token, { warTokenId: row.token, gained, lost, net: gained - lost });
  }
  return out;
}

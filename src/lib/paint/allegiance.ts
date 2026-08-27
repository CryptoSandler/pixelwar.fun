import { query, queryOne } from "../db";

/**
 * Which side a painter is on, and who has sworn to whom.
 *
 * The write side lives in `paintPixel`, inside the paint transaction, because
 * the first pixel is what commits a painter and the commitment has to be
 * atomic with the pixel it came from. This module is everything that only
 * reads — the screens that need to say "you fight for X" before a painter has
 * done anything, and the scoreboard's sworn counts.
 */

export type Allegiance = {
  warTokenId: string;
  ticker: string | null;
  /** The wallet that proved it holds this token, if this painter swore one. */
  wallet: string | null;
  swornAt: Date | null;
};

/** This painter's side in this war, or null if they have not painted yet. */
export async function allegianceOf(
  warId: string,
  painterKey: string,
): Promise<Allegiance | null> {
  const row = await queryOne<{
    war_token_id: string;
    ticker: string | null;
    wallet: string | null;
    sworn_at: Date | null;
  }>(
    `SELECT p.war_token_id, t.ticker, p.wallet, p.sworn_at
       FROM war_painters p
       LEFT JOIN war_tokens t ON t.id = p.war_token_id
      WHERE p.war_id = $1 AND p.painter_key = $2`,
    [warId, painterKey],
  );

  return row
    ? {
        warTokenId: row.war_token_id,
        ticker: row.ticker,
        wallet: row.wallet,
        swornAt: row.sworn_at,
      }
    : null;
}

/**
 * How many painters each token has, and how many of those are sworn.
 *
 * TWO NUMBERS, NOT ONE, because they answer different questions and the
 * difference is the whole status ladder. `painters` is the army — the volume
 * a community's admission actually buys. `sworn` is how many of them proved
 * they hold the token, which is the credential the community itself issues
 * and the reason a painter would go and buy one.
 *
 * Returned as a map keyed by token so the scoreboard can join it to counts it
 * already has, rather than making the caller loop.
 */
export async function armyCounts(
  warId: string,
): Promise<Map<string, { painters: number; sworn: number }>> {
  const rows = await query<{ war_token_id: string; painters: string; sworn: string }>(
    `SELECT war_token_id,
            count(*)                                      AS painters,
            count(*) FILTER (WHERE wallet IS NOT NULL)    AS sworn
       FROM war_painters
      WHERE war_id = $1
      GROUP BY war_token_id`,
    [warId],
  );

  return new Map(
    rows.map((row) => [
      row.war_token_id,
      { painters: Number(row.painters), sworn: Number(row.sworn) },
    ]),
  );
}

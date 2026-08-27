/**
 * The feed's arithmetic, with nothing underneath it.
 *
 * ITS OWN MODULE FOR THE REASON `signature.ts` GIVES, and it is the same
 * mistake one file over: these two functions are needed in the BROWSER, and
 * they were written next to the query that feeds them — which imports `db`,
 * which imports `pg`, which drags `dns`, `fs`, `net` and `tls` into a client
 * bundle. Turbopack refused to build it, which is the good outcome; the bad
 * one is a bundle that ships a Postgres driver to every visitor.
 *
 * So the arithmetic lives here, importing nothing, and `activity-feed.ts`
 * keeps the query and imports these.
 */

export type ActivityEvent = {
  seq: number;
  x: number;
  y: number;
  colourSlot: number;
  ticker: string | null;
  paintedAt: Date;
};

/**
 * Turns rows into events, given the board width.
 *
 * The index-to-coordinate arithmetic is the part that is easy to get off by
 * one, and it is testable here without a database.
 */
export function toActivityEvents(
  rows: Array<{
    seq: string | number;
    idx: number;
    colour_slot: number;
    ticker: string | null;
    painted_at: Date;
  }>,
  width: number,
): ActivityEvent[] {
  return rows.map((row) => ({
    seq: Number(row.seq),
    x: row.idx % width,
    y: Math.floor(row.idx / width),
    colourSlot: row.colour_slot,
    ticker: row.ticker,
    paintedAt: row.painted_at,
  }));
}

export type Leader = { ticker: string; owned: number; share: number } | null;

/**
 * Who is winning, as one sentence's worth of facts.
 *
 * NULL WHEN NOBODY IS, and that is a distinct answer rather than a zero. A
 * board where every token holds nothing has no leader — printing "T3 leads
 * with 0" would be a headline about nothing, and the empty state deserves
 * its own words.
 */
export function leaderOf(
  tokens: Array<{ ticker: string; owned: number }>,
  boardPixels: number,
): Leader {
  const best = tokens.reduce<{ ticker: string; owned: number } | null>(
    (top, token) => (token.owned > (top?.owned ?? 0) ? token : top),
    null,
  );
  if (!best || best.owned === 0) return null;
  return {
    ticker: best.ticker,
    owned: best.owned,
    share: boardPixels > 0 ? (best.owned / boardPixels) * 100 : 0,
  };
}

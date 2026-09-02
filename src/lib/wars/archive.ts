import { query } from "../db";
import type { War } from "./lifecycle";

/**
 * A finished war's result: who held what when the clock stopped.
 *
 * WHY THIS IS NOT `/api/leaderboard`. That route answers a question about a
 * war in motion — armies, momentum, the last few paints — and it re-answers it
 * every two seconds. This answers a question that can never change again, for
 * a page a crawler and a share card read. Sharing one function between them
 * would mean the archive paying for a momentum snapshot on a war whose
 * momentum has been zero since it ended, and the live poll carrying an
 * ordering it does not use.
 *
 * WHAT IS SHARED IS THE SOURCE, WHICH IS THE PART THAT MATTERS:
 * `token_pixel_counts`, counted by ATTRIBUTED token. Since the palette was
 * freed the colour on the board says nothing about who owns a pixel, so a
 * result derived from canvas bytes would be a different — and wrong — answer
 * to the same question.
 */

export type FinalStanding = {
  warTokenId: string;
  ticker: string;
  name: string;
  /** The token's flag, for the chip. Not the colour of any pixel it holds. */
  colourSlot: number;
  logoUrl: string | null;
  /** Pixels held when the clock stopped. */
  owned: number;
  /** Pixels ever placed by this token's painters, held or since overpainted. */
  placed: number;
};

/**
 * The final table, best first.
 *
 * ORDERED BY `owned`, NOT BY `placed`, and the distinction is the product's
 * own rule rather than a preference: DESIGN.md §8 says the leaderboard counts
 * pixels HELD and never pixels placed, and that copy would be a lie next to a
 * ranking sorted the other way. `placed` is carried because the gap between
 * the two is the most interesting number on the page — a token that placed
 * forty thousand pixels and held two hundred was fought to a standstill, and
 * neither figure says that alone.
 *
 * `colour_slot ASC` breaks a tie, so two tokens on the same count come back in
 * the same order on every render. Without it Postgres is free to reorder rows
 * between two identical requests, and the ranking would shuffle on reload for
 * no reason a reader could see.
 *
 * INCLUDES TOKENS THAT HELD NOTHING, deliberately. A community that paid its
 * admission and got wiped off the board still entered the war, and dropping it
 * from the result would make the page disagree with the receipt. Zero is a
 * result; absence is a lie.
 */
export async function finalStandings(warId: string): Promise<FinalStanding[]> {
  const rows = await query<{
    id: string;
    ticker: string;
    name: string;
    colour_slot: number;
    logo_url: string | null;
    owned: number;
    placed: number;
  }>(
    `SELECT t.id, t.ticker, t.name, t.colour_slot, t.logo_url,
            COALESCE(c.owned, 0)  AS owned,
            COALESCE(c.placed, 0) AS placed
       FROM war_tokens t
       LEFT JOIN token_pixel_counts c ON c.war_token_id = t.id
      WHERE t.war_id = $1 AND t.status = 'active'
      ORDER BY owned DESC, t.colour_slot ASC`,
    [warId],
  );

  return rows.map((row) => ({
    warTokenId: row.id,
    ticker: row.ticker,
    name: row.name,
    colourSlot: row.colour_slot,
    logoUrl: row.logo_url,
    owned: row.owned,
    placed: row.placed,
  }));
}

/**
 * Who took the board, or null when nobody did.
 *
 * NULL IS A DISTINCT ANSWER AND NOT A ZERO, the same judgement `leaderOf`
 * makes one directory over: a war whose tokens all hold nothing has no winner,
 * and "T3 took the board with 0 pixels" is a headline about nothing. The
 * screens above this decide what to say instead; this only declines to invent
 * one.
 *
 * A TIE GOES TO THE LOWER FLAG SLOT, which is to say to whoever entered
 * earlier, because slots are handed out in order. That is arbitrary and it is
 * written down here rather than left to the ORDER BY, so the next person to
 * read it knows it was chosen. The alternative — declaring a draw — is a
 * second result shape for every screen and every share card to carry, for a
 * case that needs two communities to finish a war on the identical pixel
 * count.
 */
export function winnerOf(standings: FinalStanding[]): FinalStanding | null {
  const best = standings[0];
  return best && best.owned > 0 ? best : null;
}

/** Pixels painted on the board at the end, across every token. */
export function paintedTotal(standings: FinalStanding[]): number {
  return standings.reduce((total, standing) => total + standing.owned, 0);
}

/**
 * A war's result as one number a reader can compare: the share of the board
 * the winner ended up holding.
 *
 * Of the BOARD and not of the painted area, which is the same choice the live
 * scoreboard's percentage makes. "62% of the pixels that were painted" is a
 * statistic about the other tokens; "12% of the board" is a statistic about
 * the war, and the second is what the number is for.
 */
export function shareOfBoard(owned: number, war: Pick<War, "width" | "height">): number {
  const pixels = war.width * war.height;
  return pixels > 0 ? (owned / pixels) * 100 : 0;
}

/** A war's winner, flattened to what a list row needs. */
export type WarWinner = { ticker: string; colourSlot: number; owned: number };

/**
 * The winner of each of `warIds`, in one query.
 *
 * WHY THIS EXISTS RATHER THAN CALLING `finalStandings` PER WAR. The archive
 * renders a row per finished war and every row names a winner. A loop would
 * be one query per war on a page whose whole job is to grow — fifty wars, one
 * page, fifty round trips to Neon, each one over the network. `DISTINCT ON`
 * answers it once.
 *
 * `owned > 0` IS IN THE JOIN AND NOT IN A WHERE, deliberately. In a WHERE it
 * would drop the war itself from the result when nobody held a pixel, and the
 * caller would read that as "no such war" rather than "no winner" — the same
 * conflation `winnerOf` refuses. Here a war with no held pixels comes back
 * absent from the map, which the caller reads as null, which is the answer.
 *
 * The ordering that decides a tie is the one `winnerOf` documents: the lower
 * flag slot, which is to say whoever entered earlier.
 */
export async function winnersFor(warIds: string[]): Promise<Map<string, WarWinner>> {
  if (warIds.length === 0) return new Map();

  const rows = await query<{
    war_id: string;
    ticker: string;
    colour_slot: number;
    owned: number;
  }>(
    `SELECT DISTINCT ON (c.war_id)
            c.war_id, t.ticker, t.colour_slot, c.owned
       FROM token_pixel_counts c
       JOIN war_tokens t ON t.id = c.war_token_id AND t.status = 'active'
      WHERE c.war_id = ANY($1) AND c.owned > 0
      ORDER BY c.war_id, c.owned DESC, t.colour_slot ASC`,
    [warIds],
  );

  return new Map(
    rows.map((row) => [
      row.war_id,
      { ticker: row.ticker, colourSlot: row.colour_slot, owned: row.owned },
    ]),
  );
}

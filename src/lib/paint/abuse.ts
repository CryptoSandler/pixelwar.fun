import { queryOne } from "../db";

/**
 * "Something odd is happening on this board." Nothing more, on purpose.
 *
 * WHAT THIS IS NOT. Not a classifier, not a filter, and not a brake. It
 * cannot tell a raid from an attack, and the reason is not that the code is
 * simple — it is that THE TWO ARE THE SAME SHAPE. A community coordinating on
 * Telegram to fill a corner of the board produces exactly the signal an
 * attacker produces: a burst of paints concentrated in one region. That is
 * also the single behaviour this product exists to cause.
 *
 * So nothing here acts. It reports, a human looks, and the human decides. An
 * automatic brake tuned to catch the attack would fire on every successful
 * launch moment, which is to say it would punish the case the whole product
 * is for.
 *
 * WHAT THE OPERATOR NEEDS, and all this provides: how fast, and where. Those
 * two are enough to judge in seconds — a burst spread over the board is a
 * busy war, and a burst inside one 10x10 cell is a picture being drawn, and
 * whether that picture is a logo or a swastika is a question only eyes
 * answer.
 */

/**
 * How far back to look.
 *
 * Short enough that a burst is not averaged away by a quiet hour, long enough
 * that a handful of paints in the same second does not read as a spike.
 */
export const ABUSE_WINDOW_MINUTES = Number(process.env.ABUSE_WINDOW_MINUTES ?? 10);

/**
 * Paints per minute across the whole board before it is worth a look.
 *
 * A GUESS, and labelled as one. It is derived from the only rate data that
 * exists — a load test, which measured what the SYSTEM can do rather than
 * what people do — so it is certain to be wrong in one direction or the
 * other until a real war produces real numbers. It is an environment
 * variable for exactly that reason: correcting it costs a variable change,
 * not a deploy of new code. See docs/operations.md.
 */
export const ABUSE_RATE_PER_MINUTE = Number(process.env.ABUSE_RATE_PER_MINUTE ?? 120);

/**
 * Paints inside one grid cell, in the window, before it is worth a look.
 *
 * Concentration matters more than volume: a busy war is paints everywhere,
 * and a picture is paints in one place. A 10x10 cell is 100 pixels, so 60 in
 * ten minutes means somebody is filling it deliberately.
 */
export const ABUSE_CELL_PAINTS = Number(process.env.ABUSE_CELL_PAINTS ?? 60);

/** Board is diced into cells this wide for the concentration check. */
const CELL = 10;

export type AbuseSignal = {
  windowMinutes: number;
  /** Paints across the whole board in the window. */
  paints: number;
  perMinute: number;
  /** The busiest cell, as its top-left corner, or null when the board is quiet. */
  hottest: { x: number; y: number; paints: number } | null;
  /** True when either threshold is crossed. Means "look", never "act". */
  worthALook: boolean;
};

/**
 * Reads the last window of paints and reports rate and concentration.
 *
 * Counts `pixel_events` rather than `pixels`, because a region painted and
 * repainted twenty times is exactly the case worth seeing and `pixels` keeps
 * only the last state of each cell.
 *
 * Cleared cells are excluded — a moderator reverting a region is not a burst
 * of painting, and counting their cleanup as suspicious activity would make
 * the alert fire hardest immediately after somebody dealt with the thing it
 * was warning about.
 */
export async function abuseSignal(warId: string, width: number): Promise<AbuseSignal> {
  const total = await queryOne<{ n: string }>(
    `SELECT count(*) AS n FROM pixel_events
      WHERE war_id = $1
        AND war_token_id IS NOT NULL
        AND painted_at > now() - ($2 || ' minutes')::interval`,
    [warId, String(ABUSE_WINDOW_MINUTES)],
  );

  const hot = await queryOne<{ cx: number; cy: number; n: string }>(
    `SELECT ((idx % $3) / $4)::int AS cx, ((idx / $3) / $4)::int AS cy, count(*) AS n
       FROM pixel_events
      WHERE war_id = $1
        AND war_token_id IS NOT NULL
        AND painted_at > now() - ($2 || ' minutes')::interval
      GROUP BY cx, cy
      ORDER BY count(*) DESC
      LIMIT 1`,
    [warId, String(ABUSE_WINDOW_MINUTES), width, CELL],
  );

  const paints = Number(total?.n ?? 0);
  const perMinute = ABUSE_WINDOW_MINUTES > 0 ? paints / ABUSE_WINDOW_MINUTES : 0;
  const hottest = hot
    ? { x: hot.cx * CELL, y: hot.cy * CELL, paints: Number(hot.n) }
    : null;

  return {
    windowMinutes: ABUSE_WINDOW_MINUTES,
    paints,
    perMinute: Math.round(perMinute * 10) / 10,
    hottest,
    worthALook:
      perMinute >= ABUSE_RATE_PER_MINUTE ||
      (hottest?.paints ?? 0) >= ABUSE_CELL_PAINTS,
  };
}

/**
 * The signal for whichever war is running, or null when none is.
 *
 * Deliberately only the current war. A finished board cannot get worse, and
 * an alert about one would be telling an operator to go and look at something
 * nobody can paint on any more.
 */
export async function currentAbuseSignal(): Promise<
  (AbuseSignal & { warSlug: string }) | null
> {
  const war = await queryOne<{ id: string; slug: string; width: number }>(
    `SELECT id, slug, width FROM wars WHERE status = 'live' ORDER BY starts_at DESC LIMIT 1`,
  );
  if (!war) return null;
  const signal = await abuseSignal(war.id, war.width);
  return { ...signal, warSlug: war.slug };
}

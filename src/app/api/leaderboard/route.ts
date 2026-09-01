import { query } from "../../../lib/db";
import { json } from "../../../lib/http";
import { recentActivity } from "../../../lib/canvas/activity-feed";
import { territoryMomentum } from "../../../lib/canvas/momentum";
import { armyCounts } from "../../../lib/paint/allegiance";
import { warBySlug } from "../../../lib/wars/lifecycle";

export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
  const slug = new URL(request.url).searchParams.get("war");
  if (!slug) return json({ error: "war is required" }, { status: 400 });

  const war = await warBySlug(slug);
  if (!war) return json({ error: "No such war" }, { status: 404 });

  const rows = await query<{
    id: string;
    name: string;
    ticker: string;
    colour_slot: number;
    logo_url: string | null;
    owned: number;
    placed: number;
  }>(
    `SELECT t.id, t.name, t.ticker, t.colour_slot, t.logo_url,
            COALESCE(c.owned, 0)  AS owned,
            COALESCE(c.placed, 0) AS placed
       FROM war_tokens t
       LEFT JOIN token_pixel_counts c ON c.war_token_id = t.id
      WHERE t.war_id = $1 AND t.status = 'active'
      ORDER BY owned DESC, t.colour_slot ASC`,
    [war.id],
  );

  // TWO NUMBERS, NOT ONE, and the difference is the whole status ladder.
  // `painters` is the army — the volume a community's admission actually buys.
  // `sworn` is how many of them proved they hold the token, which is the
  // credential the community itself issues and the reason a painter would go
  // and buy one. See DESIGN.md §1a.
  const armies = await armyCounts(war.id);

  // Carried on the poll that already runs every two seconds rather than on a
  // second one of its own. The feed and the standings are read together and
  // rendered together; two endpoints would mean two round trips to draw one
  // panel, and they could disagree by a poll interval — a leader that has
  // just been overtaken, beside the paint that overtook them.
  const activity = await recentActivity(war.id, war.width);

  // Which way the board is moving, on the same poll for the same reason. A
  // bounded range scan on the events primary key — see `territoryMomentum`
  // for what it counts and what it deliberately misses.
  const momentum = await territoryMomentum(war.id);

  return json(
    {
      tokens: rows.map((row) => ({
        id: row.id,
        name: row.name,
        ticker: row.ticker,
        colourSlot: row.colour_slot,
        // The identity people actually recognise. The first server render had
        // it and this poll dropped it, so a logo appeared and then vanished
        // two seconds later.
        logoUrl: row.logo_url,
        owned: row.owned,
        placed: row.placed,
        painters: armies.get(row.id)?.painters ?? 0,
        sworn: armies.get(row.id)?.sworn ?? 0,
        /** Pixels changing hands in the last ten minutes. A signal, not a ledger. */
        net: momentum.get(row.id)?.net ?? 0,
      })),
      activity: activity.map((event) => ({
        seq: event.seq,
        x: event.x,
        y: event.y,
        colourSlot: event.colourSlot,
        ticker: event.ticker,
        paintedAt: event.paintedAt.toISOString(),
      })),
    },
    { headers: { "cache-control": "public, s-maxage=1, stale-while-revalidate=4" } },
  );
}

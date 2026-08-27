import { query } from "../../../lib/db";
import { json } from "../../../lib/http";
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
    owned: number;
    placed: number;
  }>(
    `SELECT t.id, t.name, t.ticker, t.colour_slot,
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

  return json(
    {
      tokens: rows.map((row) => ({
        id: row.id,
        name: row.name,
        ticker: row.ticker,
        colourSlot: row.colour_slot,
        owned: row.owned,
        placed: row.placed,
        painters: armies.get(row.id)?.painters ?? 0,
        sworn: armies.get(row.id)?.sworn ?? 0,
      })),
    },
    { headers: { "cache-control": "public, s-maxage=1, stale-while-revalidate=4" } },
  );
}

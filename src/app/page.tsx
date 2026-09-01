import { armyCounts } from "../lib/paint/allegiance";
import { classifyEndpoints } from "../lib/payments/cluster";
import { paymentWallet, registrationFeeLamports, solanaRpcUrls } from "../lib/payments/config";
import { query, queryOne } from "../lib/db";
import { activeTokens, currentWar, lastFinishedWar } from "../lib/wars/lifecycle";
import { Intermission, type FinishedWar } from "../components/Intermission";
import { WarView } from "../components/WarView";

export const dynamic = "force-dynamic";

/**
 * The home page, in its three states.
 *
 * `/` IS THE BOARD AND THERE IS NO LANDING IN FRONT OF IT. The recruitment
 * channel these communities actually use is a raid link from Telegram or X,
 * and a page between that link and the first pixel charges a click to
 * everyone in order to serve the few who arrived to read. So the board is
 * what `/` renders whenever there is a board to render.
 *
 * The three states, and what each is FOR:
 *
 *   LIVE       the war. `WarView`, unchanged.
 *   BETWEEN    a war is scheduled and the last one has finished. The
 *              countdown dominates — it is imminent and actionable — and the
 *              finished board sits behind it as context. "This happened, and
 *              the next one starts in 02:14:33" beats either half alone.
 *   NONE       nothing scheduled. Same screen without the countdown, and if
 *              no war has EVER finished, the same screen with a sentence
 *              instead of a board.
 *
 * All three carry the wordmark. Its absence in the old empty state was the
 * whole defect: on a deployment between wars a stranger got three sentences
 * on a bare background and no way to learn what this site is — which was
 * literally the launch-day first impression.
 */
export default async function Page() {
  const war = await currentWar();

  // A scheduled war that has not opened yet is NOT the live board. Rendering
  // WarView for it showed an empty canvas under a "has not started" overlay,
  // which throws away the one thing worth showing between wars: the war that
  // just ended.
  if (war && war.status === "live") {
    const tokens = await activeTokens(war.id);
    const armies = await armyCounts(war.id);

    /**
     * WHAT EACH TOKEN HOLDS, ON THE SERVER RENDER.
     *
     * This used to be hard-coded to zero on the reasoning that the poll fills
     * it in two seconds. It does — and for those two seconds the sidebar said
     * "Pixels 0" and "nobody holds a pixel yet" over a board with forty
     * thousand pixels on it, on every single load. A first paint that is
     * wrong and then silently corrects itself is worse than a slow one: the
     * visitor who bounces at 1.5 seconds only ever saw the lie.
     *
     * One query, on a page that is already `force-dynamic` and already makes
     * several. Read from `token_pixel_counts` by ATTRIBUTED token, the same
     * source `/api/leaderboard` and the winner query below use — the colour
     * on the board says nothing about who owns a pixel since the palette was
     * freed.
     */
    const counts = await query<{ war_token_id: string; owned: number }>(
      `SELECT war_token_id, owned FROM token_pixel_counts WHERE war_id = $1`,
      [war.id],
    );
    const owned = new Map(counts.map((row) => [row.war_token_id, row.owned]));

    const receiving = paymentWallet();

    return (
      <WarView
        // Assembled on the server, and the cluster arrives as a NAME. The
        // browser only talks to /api/rpc, so it cannot see which chain is
        // behind it; classifying here is the only place the answer exists,
        // and passing the endpoint itself would undo what that proxy is for.
        registration={{
          payTo: receiving.ok ? receiving.address : null,
          feeLamports: registrationFeeLamports().toString(),
          proxyCluster: classifyEndpoints(solanaRpcUrls()),
        }}
        war={{
          slug: war.slug,
          title: war.title,
          status: war.status,
          width: war.width,
          height: war.height,
          startsAt: war.startsAt.toISOString(),
          endsAt: war.endsAt.toISOString(),
        }}
        tokens={tokens.map((token) => ({
          id: token.id,
          ticker: token.ticker,
          name: token.name,
          colourSlot: token.colourSlot,
          logoUrl: token.logoUrl,
          owned: owned.get(token.id) ?? 0,
          painters: armies.get(token.id)?.painters ?? 0,
          sworn: armies.get(token.id)?.sworn ?? 0,
          // NULL, NOT ZERO, and the distinction is the whole point of the
          // type. Zero says "nothing moved in the last ten minutes", which is
          // a claim this render cannot make: momentum is a diff against a
          // snapshot, the snapshot is taken on the leaderboard poll, and that
          // poll has not happened yet. Null renders nothing and the number
          // appears two seconds later when it is actually known.
          net: null,
        }))}
      />
    );
  }

  const finished = await lastFinishedWar();
  let result: FinishedWar | null = null;

  if (finished) {
    // The winner is whoever holds the most pixels at the end. Read from
    // `token_pixel_counts`, which counts by ATTRIBUTED token — the colour on
    // the board says nothing about who owns a pixel since the palette was
    // freed.
    const winner = await queryOne<{ ticker: string; colour_slot: number; owned: number }>(
      `SELECT t.ticker, t.colour_slot, c.owned
         FROM token_pixel_counts c
         JOIN war_tokens t ON t.id = c.war_token_id
        WHERE c.war_id = $1 AND c.owned > 0
        ORDER BY c.owned DESC
        LIMIT 1`,
      [finished.id],
    );

    result = {
      slug: finished.slug,
      title: finished.title,
      width: finished.width,
      height: finished.height,
      endedAt: (finished.endedAt ?? finished.endsAt).toISOString(),
      winner: winner
        ? { ticker: winner.ticker, colourSlot: winner.colour_slot, owned: winner.owned }
        : null,
    };
  }

  return (
    <Intermission
      finished={result}
      nextOpensAt={war ? war.startsAt.toISOString() : null}
      nextTitle={war ? war.title : null}
    />
  );
}

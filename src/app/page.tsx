import Link from "next/link";
import { armyCounts } from "../lib/paint/allegiance";
import { activeTokens, currentWar } from "../lib/wars/lifecycle";
import { WarView } from "../components/WarView";

export const dynamic = "force-dynamic";

export default async function Page() {
  const war = await currentWar();
  if (!war) {
    return (
      <main className="grid min-h-screen place-items-center p-8 text-center">
        <div>
          <h1 className="text-2xl font-semibold">No war is running.</h1>
          {/* Full-strength ink, not a quiet one. This sits on the surround,
              where DESIGN.md §9 leaves no headroom at all — INK itself reaches
              only 7.20:1 against a body floor of 7 — so quiet text does not
              belong here and the fix is to stop quieting it. It was
              `opacity-70`, which rendered 3.85:1. */}
          <p>The next one will appear here when it opens.</p>
          {/* The other half of "nothing links to /join". The HUD link only
              exists inside `WarView`, which is exactly what this branch
              renders instead of — so between wars the checkout was reachable
              by typing the path and no other way, which is the state somebody
              arriving early is most likely to be in. */}
          <p className="mt-4">
            <Link className="underline" href="/join">
              Add your token to the next war
            </Link>
          </p>
        </div>
      </main>
    );
  }

  const tokens = await activeTokens(war.id);
  // Read here rather than left at zero for a poll cycle: the sworn mark is a
  // recruiting signal, and a scoreboard whose badges appear two seconds after
  // the page does looks like a glitch on the first paint everybody sees.
  const armies = await armyCounts(war.id);

  return (
    <WarView
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
        owned: 0,
        painters: armies.get(token.id)?.painters ?? 0,
        sworn: armies.get(token.id)?.sworn ?? 0,
      }))}
    />
  );
}

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
        </div>
      </main>
    );
  }

  const tokens = await activeTokens(war.id);

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
      }))}
    />
  );
}

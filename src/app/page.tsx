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
          <p className="opacity-70">The next one will appear here when it opens.</p>
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

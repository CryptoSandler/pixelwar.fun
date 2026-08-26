import { Cabinet } from "../../components/Cabinet";
import { JoinFlow } from "../../components/JoinFlow";
import { freeColours } from "../../lib/payments/orders";
import { currentWar } from "../../lib/wars/lifecycle";

export const dynamic = "force-dynamic";

/**
 * The entry screen.
 *
 * The war and its free colours are read here rather than fetched by the
 * client, so the picker is right on the first paint instead of empty for a
 * round trip. `GET /api/colours` then keeps it right, because free is a
 * fact with a very short shelf life.
 */
export default async function JoinPage() {
  const war = await currentWar();

  if (!war) {
    return (
      <Cabinet label="Entry">
        <section className="panel bevel p-6">
          <h1 className="text-[20px] font-medium">No war is open for entry.</h1>
          <p className="mt-2 text-[13px] opacity-80">
            The next one will appear here when it is scheduled.
          </p>
        </section>
      </Cabinet>
    );
  }

  const free = await freeColours(war.id);

  return (
    <Cabinet label="Entry">
      <section className="panel bevel flex flex-col gap-1 p-4">
        <h1 className="text-[20px] font-medium">Enter {war.title}</h1>
        <p className="text-[13px] opacity-80">
          One token, one colour, for the length of the war. Anyone can paint in it, and any pixel
          can be painted over — the leaderboard counts the pixels a token holds right now.
        </p>
      </section>

      {free.length === 0 ? (
        <section className="panel bevel p-4">
          <p className="text-[13px]">
            Every colour in this war is taken. Nothing more can enter it.
          </p>
        </section>
      ) : (
        <JoinFlow
          war={{
            slug: war.slug,
            title: war.title,
            maxTokens: war.maxTokens,
            entryPriceUsd: war.entryPriceUsd,
          }}
          initialFree={free}
        />
      )}
    </Cabinet>
  );
}

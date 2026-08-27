import Link from "next/link";
import { Cabinet } from "../../components/Cabinet";
import { JoinFlow } from "../../components/JoinFlow";
import { PAYMENTS_UNCONFIGURED_MESSAGE } from "../../lib/payments/checkout";
import { paymentWallet } from "../../lib/payments/config";
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
          <p className="mt-2 muted text-[13px]">
            The next one will appear here when it is scheduled.
          </p>
        </section>
      </Cabinet>
    );
  }

  /**
   * A deployment that cannot receive money does not show a checkout.
   *
   * Without this the visitor fills the whole form, picks a colour, presses
   * the button and gets a 500 from `POST /api/orders` — which is technically
   * a correct refusal and a terrible way to learn it. The condition is known
   * here, before anything is asked of them.
   *
   * The message says nothing about which environment variable is missing:
   * that is a configuration fault, it belongs in the server log, and
   * `paymentWallet()` already puts it there. See `checkout.ts`.
   */
  const wallet = paymentWallet();
  if (!wallet.ok) {
    console.error(`GET /join: ${wallet.reason}`);
    return (
      <Cabinet label="Entry">
        <section className="panel bevel flex flex-col gap-2 p-6">
          <h1 className="text-[20px] font-medium">Entries are not open yet.</h1>
          <p className="muted text-[13px]">{PAYMENTS_UNCONFIGURED_MESSAGE}</p>
          <Link href="/" className="btn-primary mt-2 self-start px-4 py-2">
            Go to the board
          </Link>
        </section>
      </Cabinet>
    );
  }

  const free = await freeColours(war.id);

  return (
    <Cabinet label="Entry">
      <section className="panel bevel flex flex-col gap-1 p-4">
        <h1 className="text-[20px] font-medium">Enter {war.title}</h1>
        {/* Rewritten after the palette was freed. This used to say "one
            token, one colour, for the length of the war", which stopped being
            true the moment colours stopped belonging to tokens: what a token
            gets is a SLOT and a flag, and the paint on the board can be any
            of the twenty-four. */}
        <p className="muted text-[13px]">
          Your token takes a slot in this war and a flag colour on the scoreboard. Anyone can
          paint, in any colour, and any pixel can be painted over — the scoreboard counts the
          pixels your token holds right now, whatever colour they are.
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

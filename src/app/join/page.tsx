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
 * The free list is still read here, but no longer to fill a picker — nobody
 * chooses a flag any more. It answers one question: is there a seat left at
 * all. `freeColours` is the same query capacity is judged by, so asking it
 * here means the screen and the INSERT agree about "full".
 *
 * NO PRICE ON THIS PAGE. The amount is named once, on the confirmation
 * screen, immediately before the wallet dialog.
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
        {/* Rewritten twice, and both times for the same reason: the sentence
            kept describing a colour as the thing being bought. It said "one
            token, one colour, for the whole war" until the palette was freed,
            then "a slot and a flag colour" until the flag stopped being
            chosen. What a token gets is a SEAT; the flag is assigned and the
            logo is the identity anybody actually recognises. */}
        <p className="muted text-[13px]">
          Your token takes a seat in this war, with its logo and a flag on the scoreboard. Anyone
          can paint, in any colour, and any pixel can be painted over — the scoreboard counts the
          pixels your token holds right now, whatever colour they are.
        </p>
      </section>

      {free.length === 0 ? (
        <section className="panel bevel p-4">
          <p className="text-[13px]">This war is full. Nothing more can enter it.</p>
        </section>
      ) : (
        <JoinFlow war={{ slug: war.slug, title: war.title, maxTokens: war.maxTokens }} />
      )}

      {/*
        THE TERMS, REACHABLE FROM THE SCREEN THAT ASKS FOR MONEY. `/rules` says
        what overpaying does, what a late payment does, and that there are no
        automatic refunds — every one of them a branch this flow can actually
        take. A payer who meets one of those branches for the first time on the
        failure screen was never told; a link here is the cheapest way that
        stops being true.
      */}
      <p className="muted text-[13px]">
        <Link href="/rules" className="underline underline-offset-2">
          What entering buys, and what happens if a payment goes wrong
        </Link>
      </p>
    </Cabinet>
  );
}

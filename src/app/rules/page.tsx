import type { Metadata } from "next";
import Link from "next/link";
import { Cabinet } from "../../components/Cabinet";
import { supportContact } from "../../lib/payments/config";

/**
 * The rules, as rule -> consequence.
 *
 * A TABLE AND NOT PROSE, which the spec calls the one structural thing worth
 * taking from wplace: a reader arrives here because something specific
 * happened to them, and a table lets them find their own case instead of
 * reading an essay to discover it is not covered.
 *
 * ## What is allowed to be on this page, and it is a short list
 *
 * **Only obligations the product has already made.** Every line below
 * restates something this application already does, in code, on some other
 * screen — a refusal a route returns, a policy a module applies. Nothing here
 * is new. A rules page is the most one-way surface a product has: it is
 * published, it is quoted back at you, and it cannot be walked back without
 * being caught having changed the terms. So it documents; it does not decide.
 *
 * **No prices.** Not the admission, not the registration. Both are per-war or
 * per-deployment configuration and a number written here would be wrong the
 * first time either moves — and wrong in the one place a reader would be right
 * to treat as authoritative. The amount is named once, on the screen
 * immediately before the wallet dialog, which is also where `/join` puts it.
 *
 * **Three sentences that are FORBIDDEN here, each for a recorded reason:**
 *
 * 1. Anything promising painting is "free forever", that no wallet is ever
 *    needed, or that an allegiance is permanent or irrevocable. DESIGN.md §1a,
 *    "Copy consequence, and it is absolute". The recruit's lock is soft and
 *    copy saying otherwise would be a lie the product tells about itself. The
 *    sanctioned form for allegiance is the one that is true either way — *you
 *    fight for one token this war* — and it is used verbatim below.
 * 2. Anything calling the registration a network fee. Solana's own fee on that
 *    transfer is under a thousandth of a cent and this one is ours; saying
 *    otherwise is a lie about who is being paid.
 * 3. Anything telling a reader that a ban is permanent, how long one lasts, or
 *    that one can be appealed. `docs/operations.md`, "Ban terms" — the ban
 *    term is the owner's open decision, the mechanism supports both futures,
 *    and a page that named a duration would settle it by publication. So the
 *    line below says painting can be refused and stops there, exactly as
 *    `isBanned` refuses and stops there.
 *
 * The registration IS described as permanent per wallet, and that is the one
 * permanence claim §1a explicitly allows, because a row in `registrations`
 * never expires.
 */

export const metadata: Metadata = {
  title: "Rules — pixelwar.fun",
  description: "What entering a war buys, how painting is limited, and what gets cleared.",
};

type Rule = { rule: string; consequence: string };

/**
 * Entering a war. The seat, and every way a payment can go sideways.
 *
 * Each of these is a branch that exists in `settle.ts` or `orders.ts` today —
 * overpayment accepted, the late confirm's attempt at its own colour, the
 * payer check the pasted-signature path cannot make, and the filing that
 * happens when real money arrives with no seat to land in.
 */
const ENTERING: Rule[] = [
  {
    rule: "A token enters a war by paying that war's admission in SOL, once.",
    consequence: "It takes a seat for that war, with its logo and a flag colour on the scoreboard.",
  },
  {
    rule: "You pay more than the admission.",
    consequence: "The extra is recorded and the entry is accepted. It buys nothing further.",
  },
  {
    rule: "You pay after your reservation's window has closed.",
    consequence:
      "We try to give the same seat back. If the colour has gone to somebody else, or the war has ended, the payment is filed and matched by hand instead.",
  },
  {
    rule: "You pay from a wallet other than the one that opened the order.",
    consequence:
      "The entry is refused. The payment is not kept quietly — it is filed with the sender the chain names, so it can be returned or applied.",
  },
  {
    rule: "You pay by pasting a transaction signature instead of connecting a wallet.",
    consequence:
      "There is no wallet on the order to check the payment against, so the first claim inside the window takes it.",
  },
  {
    rule: "A payment reaches us that no order can claim.",
    consequence:
      "It is filed with the sender the chain names, never with a sender somebody asserts, and reuniting it is manual work.",
  },
  {
    rule: "You want a refund.",
    consequence:
      "There are no automatic refunds. If we cancel a war, an operator sends SOL back by hand.",
  },
];

/**
 * Painting. The registration, the limits, and the one sentence about
 * allegiance that is true whichever way the product goes.
 */
const PAINTING: Rule[] = [
  {
    rule: "Painting takes a one-time registration: one wallet, one SOL transfer, once.",
    consequence:
      "The registration is permanent for that wallet, across every war there will ever be. You do not pay it again.",
  },
  {
    rule: "The registration is paid to us.",
    consequence:
      "Solana charges its own fee on the transfer, separately and to itself. Ours is not that, and we do not describe it as one.",
  },
  {
    rule: "Your first pixel in a war picks your side.",
    consequence: "You fight for one token this war.",
  },
  {
    rule: "You paint again before your cooldown is up.",
    consequence: "The paint is refused until it is. Each war sets its own cooldown.",
  },
  {
    rule: "A lot of painting arrives from one address, or one neighbourhood of addresses, at once.",
    consequence: "It is rate limited. The limits are not published, and they move.",
  },
  {
    rule: "You paint over somebody else's pixel.",
    consequence:
      "That is the game. The scoreboard counts pixels held, not pixels placed, and any pixel can be taken back.",
  },
  {
    rule: "You connect a wallet that holds a token and swear to it.",
    consequence: "You fight under that token's badge. It costs nothing beyond the token you hold.",
  },
];

/**
 * Moderation. Deliberately the shortest section, and deliberately vague about
 * consequences to the offender — see the forbidden sentences above.
 */
const CLEARING: Rule[] = [
  {
    rule: "Something on the board targets a person — their name, their face, where they live.",
    consequence: "It is cleared. Overpainting a rival is the game; going after somebody is not.",
  },
  {
    rule: "Something on the board would get this site taken down.",
    consequence: "It is cleared.",
  },
  {
    rule: "A region is cleared.",
    consequence:
      "The pixels go, and the scoreboard is corrected so that no community appears to lose ground because a moderator acted.",
  },
  {
    rule: "A painter keeps doing it.",
    consequence: "Painting can be refused for the wallet or the browser it came from.",
  },
];

/** What happens at the deadline, and what survives it. */
const ENDING: Rule[] = [
  {
    rule: "A war reaches its deadline.",
    consequence:
      "The board freezes, the result is the ranking by pixels held, and nothing further can be painted.",
  },
  {
    rule: "A war has finished.",
    consequence:
      "It keeps a page of its own, with its final board, its full standings and an image anyone can share.",
  },
  {
    rule: "An operator can end a war early.",
    consequence: "It freezes at that moment, and the result is whatever was on the board.",
  },
];

export default function RulesPage() {
  const contact = supportContact();

  return (
    <Cabinet label="Rules">
      <section className="panel bevel flex flex-col gap-1 p-4">
        <h1 className="text-[20px] font-medium">Rules</h1>
        <p className="muted text-[13px]">
          What entering buys, what painting takes, and what gets cleared. Find your own case
          below — each line is a thing that happens and what follows from it.
        </p>
      </section>

      <RuleSection title="Entering a war" rules={ENTERING} />
      <RuleSection title="Painting" rules={PAINTING} />
      <RuleSection title="What gets cleared" rules={CLEARING} />
      <RuleSection title="When a war ends" rules={ENDING} />

      <section className="panel bevel flex flex-col gap-1 p-4">
        <h2 className="section-label muted">If a payment went wrong</h2>
        {/*
          The same honesty `filedClause` in `settle.ts` applies: a deployment
          with no contact configured says so rather than naming an inbox that
          bounces. This page must not promise a queue that does not exist.
        */}
        <p className="text-[13px]">
          {contact ? (
            <>
              Write to <span className="numeric">{contact}</span> with your transaction signature.
              A person reads it; it is not automated.
            </>
          ) : (
            "This deployment has no support contact configured yet."
          )}
        </p>
      </section>

      <nav className="flex flex-wrap gap-2">
        <Link href="/wars" className="btn-secondary px-4 py-2">
          Finished wars
        </Link>
        <Link href="/" className="btn-primary px-4 py-2">
          Go to the board
        </Link>
      </nav>
    </Cabinet>
  );
}

/**
 * One section of the table.
 *
 * A DEFINITION LIST RATHER THAN A `<table>`, and the reason is the phone. Two
 * columns of sentences at 390px gives each of them about eleven characters a
 * line, which is a table that technically fits and cannot be read. Stacked
 * below the rail breakpoint and paired above it: the same rule -> consequence
 * relationship, expressed by position where there is room and by order where
 * there is not. `dt`/`dd` carries the pairing to a screen reader either way,
 * which a two-column grid of divs would not.
 */
function RuleSection({ title, rules }: { title: string; rules: Rule[] }) {
  return (
    <section className="panel bevel flex flex-col gap-2 p-4">
      <h2 className="section-label muted">{title}</h2>
      <dl className="flex flex-col gap-3">
        {rules.map((entry) => (
          <div
            key={entry.rule}
            className="flex flex-col gap-0.5 rail:grid rail:grid-cols-2 rail:gap-4"
          >
            <dt className="text-[13px] font-medium">{entry.rule}</dt>
            <dd className="muted text-[13px]">{entry.consequence}</dd>
          </div>
        ))}
      </dl>
    </section>
  );
}

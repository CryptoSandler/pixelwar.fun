import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * The rules page is published copy, and published copy is one-way.
 *
 * WHY A TEST AND NOT A REVIEW. A rules page is the most quoted surface a
 * product has: it is screenshotted, it is linked in an argument, and it cannot
 * be walked back without the product being caught having changed its terms.
 * Three classes of sentence are forbidden on it, each because a document in
 * this repository says so and each because writing one would SETTLE, by
 * publication, a question the owner has deliberately left open.
 *
 * Nothing else can catch this. A forbidden sentence typechecks, lints, renders
 * and reads well.
 *
 * Matched on collapsed whitespace with comment markers stripped, per
 * CLAUDE.md, so a reflow does not turn this into a test people edit rather
 * than read.
 */

const RULES = "src/app/rules/page.tsx";

/** The page as a reader meets it: comments stripped, whitespace collapsed. */
const copy = readFileSync(RULES, "utf8")
  .replace(/\/\*[\s\S]*?\*\//g, " ")
  .replace(/^\s*\/\/.*$/gm, " ")
  .replace(/\s+/g, " ");

describe("the rules page exists and is the page this test thinks it is", () => {
  /**
   * THE CONTROL, and it is doing real work here. Every assertion below is a
   * `not.toMatch` — and a `not.toMatch` against an EMPTY string passes
   * perfectly. A wrong path, a renamed file, a comment-stripper that ate the
   * whole file: all of them would report a clean bill of health for copy that
   * was never read. So something unmissable has to be present first.
   */
  it("was read, and contains the rules", () => {
    expect(copy).toContain("export default function RulesPage");
    expect(copy).toContain("What entering buys");
    expect(copy.length).toBeGreaterThan(2_000);
  });
});

describe("the three forbidden sentences", () => {
  /**
   * DESIGN.md §1a, "Copy consequence, and it is absolute": nothing in this
   * application promises "free forever", promises "no wallet ever", or calls
   * an allegiance permanent or irrevocable. The recruit's lock is a cookie and
   * is trivially discarded; copy saying otherwise is a lie the product tells
   * about itself.
   */
  it("promises nothing about staying free, or about never needing a wallet", () => {
    expect(copy).not.toMatch(/free forever|always free|painting is free|stays free/i);

    /*
     * THE PROMISE, NOT THE WORDS. The first version of this assertion banned
     * the substring "no wallet" outright and failed on a sentence that is
     * both true and necessary: *"There is no wallet on the order to check the
     * payment against"*, which is what makes the pasted-signature path
     * first-to-claim. That is a description of a mechanism, not an offer.
     *
     * What §1a forbids is telling a visitor they will never need one. So the
     * pattern matches a CLAIM ABOUT THE READER — needing, requiring — rather
     * than the noun appearing anywhere near a negation. A test that bans
     * vocabulary instead of promises is a test people work around by
     * rewording, which leaves the promise and loses the guard.
     */
    expect(copy).not.toMatch(/(never|no|not|without)\s+(ever\s+)?(need|require)\w*\s+(a|an|any)?\s*(wallet|account)/i);
    expect(copy).not.toMatch(/(wallet|account)\s+(is\s+)?(never\s+)?(not\s+)?(required|needed)/i);
    expect(copy).not.toMatch(/no account/i);
  });

  it("never calls an allegiance permanent or irrevocable", () => {
    expect(copy).not.toMatch(/allegiance is permanent|permanently committed|irrevocab/i);
  });

  it("uses the one sanctioned form instead, which is true either way", () => {
    // DESIGN.md §1a names this sentence verbatim as the allowed wording.
    expect(copy).toContain("You fight for one token this war.");
  });

  /**
   * The registration IS permanent per wallet, and §1a explicitly allows
   * saying so, because a row in `registrations` never expires. The rule was
   * never "no permanence claims" — it is that the claim has to be one the
   * data actually makes.
   */
  it("does claim the one permanence the data supports", () => {
    expect(copy).toMatch(/registration is permanent for that wallet/i);
  });

  /**
   * DESIGN.md §1a again: Solana's own fee on the transfer is under a
   * thousandth of a cent and this one is ours. Calling it a network fee is a
   * lie about who is being paid.
   */
  it("never calls the registration a network fee", () => {
    expect(copy).not.toMatch(/network fee|gas fee|blockchain fee/i);
    expect(copy).toContain("The registration is paid to us.");
  });

  /**
   * `docs/operations.md`, "Ban terms": no copy in this application tells
   * anybody they are banned permanently, or for how long, or that a ban can
   * be appealed. The term is the owner's OPEN decision and the mechanism
   * supports both futures — a page that named a duration would settle it by
   * publication, which is precisely the door CLAUDE.md says not to slam.
   */
  it("says nothing about how long a refusal lasts, or about appealing one", () => {
    expect(copy).not.toMatch(/permanently banned|banned for|permanent ban|lifetime ban/i);
    expect(copy).not.toMatch(/appeal|reinstate|unban/i);
    expect(copy).not.toMatch(/\b(24|48|72)\s*hours?\b/i);
    // What it says instead: the refusal, and nothing after it — exactly as
    // `isBanned` refuses and records nothing.
    expect(copy).toContain("Painting can be refused");
  });
});

describe("no prices anywhere on this page", () => {
  /**
   * Both charges are configuration — the admission is per war, the
   * registration is per deployment and may legitimately be zero. A number
   * written here would be wrong the first time either moves, and wrong in the
   * one place a reader is right to treat as authoritative. The amount is named
   * once, on the screen immediately before the wallet dialog.
   */
  it("names no amount, in any denomination", () => {
    expect(copy).not.toMatch(/\d[\d,.]*\s*(SOL|USDC|USD|dollars?)/i);
    expect(copy).not.toMatch(/[$€£]\s?\d/);
    expect(copy).not.toMatch(/lamports?/i);
  });

  it("does not import anything that could put a price on the page", () => {
    // `supportContact` is the only thing this page reads from the payments
    // configuration, and it is an address rather than an amount. The failure
    // this guards is somebody reaching for `registrationFeeLamports` here
    // because it was right there in the same module.
    const source = readFileSync(RULES, "utf8");
    expect(source).toContain('import { supportContact } from "../../lib/payments/config"');
    expect(source).not.toMatch(/registrationFeeLamports|formatSol|entryPrice/);
  });
});

describe("the page describes only what the product already does", () => {
  /**
   * Every rule restates a branch that exists. These four are the ones a
   * reader is most likely to arrive here having just hit, and each maps to a
   * real refusal in `settle.ts` or `paint.ts`.
   */
  it("covers overpayment, the late confirm, the pasted signature and refunds", () => {
    expect(copy).toMatch(/pay more than the admission/i);
    expect(copy).toMatch(/window has closed/i);
    expect(copy).toMatch(/pasting a transaction signature/i);
    expect(copy).toMatch(/no automatic refunds/i);
  });

  /** DESIGN.md §8: never imply a pixel is permanent. */
  it("says the board counts pixels held rather than placed", () => {
    expect(copy).toMatch(/counts pixels held, not pixels placed/i);
    expect(copy).toMatch(/any pixel can be taken back/i);
  });

  /**
   * The reasons travel with the rules. A page defended only by the test above
   * is a page whose next editor deletes a sentence and cannot tell why the
   * suite went red — the same argument `canvas-cache.test.ts` makes about its
   * number.
   */
  it("keeps its own constraints written down at the top of the file", () => {
    const doc = readFileSync(RULES, "utf8").replace(/\s+/g, " ");
    expect(doc).toContain("Only obligations the product has already made");
    expect(doc).toContain("No prices");
    expect(doc).toContain("Three sentences that are FORBIDDEN here");
  });
});

/**
 * WHO LINKS TO IT.
 *
 * A rules page nothing reaches is a rules page nobody has read, and CLAUDE.md
 * is explicit that "who calls this" is answered with a file and a line rather
 * than an intention. `/join` matters most of the four: it is the screen that
 * asks for money, and three of the rules above are branches that flow can
 * actually take.
 */
describe("the rules are reachable", () => {
  const linksToRules = (path: string) =>
    readFileSync(path, "utf8").replace(/\s+/g, " ").includes('href="/rules"');

  it("is linked from the screen that asks for money", () => {
    expect(linksToRules("src/app/join/page.tsx")).toBe(true);
  });

  it("is linked from the intermission, the archive and a war's result", () => {
    expect(linksToRules("src/components/Intermission.tsx")).toBe(true);
    expect(linksToRules("src/app/wars/page.tsx")).toBe(true);
    expect(linksToRules("src/app/wars/[slug]/page.tsx")).toBe(true);
  });

  /**
   * And the archive itself, which has the same problem one level up: two
   * finished pages and no route to them is not a feature.
   */
  it("the archive and a war's own page are reachable from the front page", () => {
    const intermission = readFileSync("src/components/Intermission.tsx", "utf8").replace(/\s+/g, " ");
    expect(intermission).toContain('href="/wars"');
    expect(intermission).toContain("href={`/wars/${finished.slug}`}");
  });
});

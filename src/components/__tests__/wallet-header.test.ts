import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * The wallet is connected from the header, on every page, once.
 *
 * A SOURCE TEST, like `rail-breakpoint.test.ts` and for the same reason:
 * there is no browser in this suite, so a click cannot be driven and a React
 * context cannot be navigated across. What CAN be asserted — and what
 * actually decides whether a connection survives navigation — is structural,
 * and it is the thing a future edit would break: WHERE the provider is
 * mounted, and how many of them there are.
 *
 * THE PROPERTY. `WalletProvider` is mounted once in `app/layout.tsx`, above
 * every route. Next keeps the layout mounted across navigations within it, so
 * the adapter's state — which wallet, connected or not, which public key —
 * outlives moving from `/` to `/join`. A page that mounted its own provider
 * would remount on arrival and drop the connection, which is exactly the bug
 * this file exists to make impossible to introduce quietly.
 */
describe("one wallet connection, shared by the whole app", () => {
  const layout = readFileSync("src/app/layout.tsx", "utf8");
  const button = readFileSync("src/components/WalletButton.tsx", "utf8");
  /**
   * The same file with its comments stripped.
   *
   * The brass assertion below is about what the button RENDERS, and the first
   * version of it read the raw source — so it failed the moment a comment
   * explained why `.btn-primary:disabled` is styled the way it is. A test
   * that a prose edit can break is a test people learn to delete. Same
   * reasoning as the defended-number rule in CLAUDE.md, which matches with
   * comment markers stripped for exactly this.
   */
  const buttonCode = button.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
  const cabinet = readFileSync("src/components/Cabinet.tsx", "utf8");
  const warView = readFileSync("src/components/WarView.tsx", "utf8");
  const intermission = readFileSync("src/components/Intermission.tsx", "utf8");
  const joinFlow = readFileSync("src/components/JoinFlow.tsx", "utf8");
  const joinPage = readFileSync("src/app/join/page.tsx", "utf8");
  const home = readFileSync("src/app/page.tsx", "utf8");

  it("mounts the provider in the root layout and nowhere else", () => {
    // The whole navigation property in one assertion: `/` renders `WarView`
    // or `Intermission`, `/join` renders `JoinFlow`, and none of them — nor
    // the pages around them — brings its own provider. So the one in the
    // layout is the only one, and it is above both routes.
    expect(layout).toContain("<WalletProvider>");

    for (const [name, source] of [
      ["WarView", warView],
      ["Intermission", intermission],
      ["JoinFlow", joinFlow],
      ["the join page", joinPage],
      ["the home page", home],
      ["the header button", button],
    ] as const) {
      expect(`${name}: ${source.includes("<WalletProvider")}`).toBe(`${name}: false`);
    }
  });

  it("reads the connection from the shared context rather than its own state", () => {
    // `useWallet()` IS the shared context. A button that kept a public key in
    // `useState` would look identical on one page and be wrong on the next.
    expect(buttonCode).toContain("useWallet()");
    expect(buttonCode).not.toMatch(/useState<[^>]*PublicKey/);
  });

  it("puts the control in the header of every screen a visitor sees", () => {
    // Three headers, because there are three: the board, the between-wars
    // screen, and the cabinet that `/join` and the admin pages wear.
    for (const [name, source] of [
      ["the cabinet", cabinet],
      ["the board", warView],
      ["the intermission", intermission],
    ] as const) {
      expect(`${name}: ${source.includes("<WalletButton />")}`).toBe(`${name}: true`);
    }
  });

  it("has no wallet step left in the entry form", () => {
    // The step said a connection belonged to one purchase. It never did.
    expect(joinFlow).not.toContain("· Wallet");
    expect(joinFlow).not.toContain("WalletConnect");
    // But the order still carries the payer when there IS one connected —
    // that binding is what stops a stranger paying somebody else's order.
    expect(joinFlow).toContain("payerPubkey");
  });

  it("keeps the first-payment note where the payment happens", () => {
    // Moved off the form with the step it used to sit under. It is a fact
    // about paying, and the confirmation screen is where paying is.
    const pay = readFileSync("src/components/PayWithWallet.tsx", "utf8").replace(/\s+/g, " ");
    expect(pay).toContain("accepts the first payment that matches");
    expect(joinFlow.replace(/\s+/g, " ")).not.toContain("accepts the first payment that matches");
  });

  it("does not make the wallet button brass", () => {
    // DESIGN.md I5: the accent is for the action a screen is FOR, and no
    // screen is for connecting a wallet.
    expect(buttonCode).not.toContain("btn-primary");
    expect(buttonCode).not.toContain("--chrome-accent");
  });
});

"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { useWallet } from "@solana/wallet-adapter-react";
import { WalletConnect } from "./WalletProvider";
import { CHAINS, getChain } from "../lib/tokens/chains";
// Type-only, and it has to stay that way: `orders.ts` is server code (node
// crypto, the pool). `import type` is erased at compile time, so what crosses
// into the client bundle is the compiler's knowledge of the union and nothing
// else — which is the whole point, since that knowledge is what makes an
// unmapped reason a build failure instead of a machine token on screen.
import type { CreateOrderFailureReason } from "../lib/payments/orders";

/**
 * Entry, in two steps that can each be corrected before either costs
 * anything: which token, which wallet, then an order.
 *
 * THE COLOUR STEP IS GONE, and it is the interesting half of this file's
 * history. A payer used to choose their community's flag from the free
 * twenty-four, which made the choice the loudest thing on the screen and the
 * likeliest way to fail an order — the picker refreshed every twenty seconds
 * because somebody else could take what you were looking at. The flag is now
 * assigned (the lowest free slot, in `createOrder`'s own INSERT) and the
 * token's identity on screen is its LOGO, which is the thing people already
 * recognise and the thing the search already fetched. A colour was never what
 * anybody was buying.
 *
 * The order is created last on purpose. Creating one takes a seat under a
 * partial unique index, and a payer who mistyped an address would hold it for
 * a token that is not theirs until the window lapsed. So the address is
 * resolved and SHOWN first — name, ticker and logo, read from DexScreener
 * rather than typed by whoever is paying — and the reservation happens only
 * once somebody has looked at what they are about to enter.
 *
 * NO PRICE ON THIS SCREEN. The amount appears once, on the confirmation
 * screen, immediately before the wallet dialog — the same place and the same
 * moment the registration flow names its fee. See DESIGN.md §8.
 */

type ResolvedToken = {
  chainId: string;
  contract: string;
  name: string;
  ticker: string;
  logoUrl: string | null;
  sourceUrl: string | null;
};

export type JoinWar = {
  slug: string;
  title: string;
  maxTokens: number;
};

/**
 * Every reason `POST /api/orders` can refuse for, as a sentence.
 *
 * The route answers a refusal with both a message and a machine `reason`, and
 * its message is built as `That order could not be started: colour_taken.` —
 * an enum name in front of a payer, which is the exact shape DESIGN.md §8
 * rules out. The reason is the part worth reading, so it is the part that is
 * read: the four values are `CreateOrderFailureReason` in
 * `lib/payments/orders.ts`, and every one of them has a sentence here.
 *
 * Anything else the route returns — a bad address, a rate limit, a token no
 * DEX has seen — already arrives as a written sentence and is shown as it
 * came.
 */
const REFUSAL_COPY: Record<CreateOrderFailureReason, string> = {
  // Was the likeliest failure in the flow when a payer picked their own flag.
  // Now it can only mean two orders raced for the same assigned slot, which
  // the war row's lock makes vanishingly unlikely — so the sentence says what
  // to do rather than describing a picker that is no longer on screen.
  colour_taken: "Two entries collided. Try again — it will pick the next free flag.",
  already_entered: "This token is already in this war. A token enters once.",
  war_full: "This war is full.",
  war_closed: "This war is not open for entry any more.",
  // The operator has not priced this war. Nothing the payer can fix, and it
  // must not read as their mistake.
  no_price: "Entry is not open on this deployment yet.",
};

export function JoinFlow({ war }: { war: JoinWar }) {
  const router = useRouter();
  const { publicKey } = useWallet();

  const [chainId, setChainId] = useState(CHAINS[0].id as string);
  const [contract, setContract] = useState("");
  const [token, setToken] = useState<ResolvedToken | null>(null);
  const [resolving, setResolving] = useState(false);
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const chain = getChain(chainId);

  async function resolve() {
    const trimmed = contract.trim();
    if (!trimmed) {
      setError("Paste the token's contract address.");
      return;
    }
    setResolving(true);
    setError(null);
    setToken(null);
    try {
      const response = await fetch(
        `/api/token?chain=${encodeURIComponent(chainId)}&contract=${encodeURIComponent(trimmed)}`,
      );
      const body = await response.json();
      if (!response.ok) {
        setError(typeof body?.error === "string" ? body.error : "That token could not be found.");
        return;
      }
      setToken(body as ResolvedToken);
    } catch {
      setError("The lookup did not come back. Try again in a moment.");
    } finally {
      setResolving(false);
    }
  }

  async function startOrder() {
    if (!token) return;
    setStarting(true);
    setError(null);
    try {
      const response = await fetch("/api/orders", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          warSlug: war.slug,
          chainId: token.chainId,
          contract: token.contract,
          // Sent only when a wallet is connected. An order that names its
          // payer can only be settled by that wallet, which is the stronger
          // position; an order without one is first-to-claim inside its
          // window, and the payment screen says so.
          ...(publicKey ? { payerPubkey: publicKey.toBase58() } : {}),
        }),
      });
      const body = await response.json();
      if (!response.ok) {
        const written =
          typeof body?.reason === "string"
            ? REFUSAL_COPY[body.reason as CreateOrderFailureReason]
            : undefined;
        setError(
          written ??
            (typeof body?.error === "string" ? body.error : "That order could not be started."),
        );
        // Re-enabled here rather than in a `finally`: on the success path the
        // page is already navigating away, and a button that came back to
        // life for that moment is a second order waiting to happen.
        setStarting(false);
        return;
      }
      router.push(`/join/${body.orderId}`);
    } catch {
      setError("The order did not come back. Try again in a moment.");
      setStarting(false);
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <Step label="1 · Token">
        <div className="flex flex-col gap-2 sm:flex-row">
          <label className="sr-only" htmlFor="chain">
            Chain
          </label>
          <select
            id="chain"
            className="field px-2 py-2"
            value={chainId}
            onChange={(event) => {
              setChainId(event.target.value);
              setToken(null);
            }}
          >
            {CHAINS.map((entry) => (
              <option key={entry.id} value={entry.id}>
                {entry.name}
              </option>
            ))}
          </select>
          <label className="sr-only" htmlFor="contract">
            Contract address
          </label>
          <input
            id="contract"
            className="field min-w-0 flex-1 px-2 py-2"
            value={contract}
            spellCheck={false}
            autoComplete="off"
            placeholder={chain?.addressPlaceholder}
            onChange={(event) => {
              setContract(event.target.value);
              setToken(null);
            }}
          />
          <button
            type="button"
            className="btn-secondary px-4 py-2"
            disabled={resolving}
            onClick={() => void resolve()}
          >
            {resolving ? "Looking…" : "Find token"}
          </button>
        </div>
        <p className="muted text-[12px]">{chain?.addressHint}</p>

        {token ? (
          <div className="bevel-in mt-2 flex items-center gap-3 p-3" style={{ background: "var(--chrome-readout)" }}>
            {token.logoUrl ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={token.logoUrl} alt="" aria-hidden width={32} height={32} />
            ) : null}
            <div className="min-w-0">
              <p className="text-[15px] font-medium">
                {token.name} <span className="numeric">({token.ticker})</span>
              </p>
              <p className="numeric truncate text-[11px]">{token.contract}</p>
            </div>
            {token.sourceUrl ? (
              <a
                className="ml-auto shrink-0 text-[12px] underline"
                href={token.sourceUrl}
                target="_blank"
                rel="noreferrer"
              >
                Check on DexScreener
              </a>
            ) : null}
          </div>
        ) : null}
      </Step>

      <Step label="2 · Wallet">
        <WalletConnect />
        <p className="muted text-[12px]">
          {publicKey
            ? "Only this wallet will be able to pay for the order."
            : "You can connect on the next screen instead. An order started without a wallet accepts the first payment that matches it."}
        </p>
      </Step>

      {/* QUIET text lives on a panel: the surround has no headroom under
          DESIGN.md §9 — full-strength ink clears its body floor at 7.20:1 and
          nothing lighter does — so a muted footnote needs a panel to sit on,
          and shares one with the action it describes. Full-strength ink on the
          surround is fine, and the payment screen's status line uses it. */}
      <section className="panel bevel flex flex-col gap-3 p-4">
        {error ? (
          <p role="alert" className="bevel-in p-3 text-[13px]" style={{ background: "var(--chrome-control)" }}>
            {error}
          </p>
        ) : null}

        <button
          type="button"
          className="btn-primary px-6 py-3"
          disabled={!token || starting}
          onClick={() => void startOrder()}
        >
          {starting ? "Starting…" : "Continue"}
        </button>
        <p className="muted text-[12px]">
          Your token&rsquo;s seat is held while the order is open. Nothing is charged until you
          approve it in your wallet on the next screen.
        </p>
      </section>
    </div>
  );
}

function Step({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <section className="panel bevel flex flex-col gap-2 p-4">
      <h2 className="section-label">{label}</h2>
      {children}
    </section>
  );
}

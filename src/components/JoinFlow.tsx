"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { useWallet } from "@solana/wallet-adapter-react";
import { ColourPicker } from "./ColourPicker";
import { WalletConnect } from "./WalletProvider";
import { CHAINS, getChain } from "../lib/tokens/chains";

/**
 * Entry, in four steps that can each be corrected before any of them costs
 * anything: which token, which colour, which wallet, then an order.
 *
 * The order is created last on purpose. Creating one reserves a colour under
 * a partial unique index, and a payer who mistyped an address would be
 * holding a seat for a token that is not theirs until the window lapsed. So
 * the address is resolved and SHOWN first — name, ticker and logo, read from
 * DexScreener rather than typed by whoever is paying — and the reservation
 * happens only once somebody has looked at what they are about to buy.
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
  entryPriceUsd: number;
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
const REFUSAL_COPY: Record<string, string> = {
  // The likeliest failure in the whole flow, and the one the picker recovers
  // from by itself: the list is refreshed on this reason, so the second
  // sentence is a description of what just happened, not a suggestion.
  colour_taken:
    "That colour was taken while you were choosing. The picker now shows what is still open.",
  already_entered: "This token is already in this war. A token can hold one colour, once.",
  war_full: "This war is full. Every colour has been claimed.",
  war_closed: "This war is not open for entry any more.",
};

/** How often the free list is refreshed while somebody is looking at it. */
const COLOUR_REFRESH_MS = 20_000;

export function JoinFlow({ war, initialFree }: { war: JoinWar; initialFree: number[] }) {
  const router = useRouter();
  const { publicKey } = useWallet();

  const [chainId, setChainId] = useState(CHAINS[0].id as string);
  const [contract, setContract] = useState("");
  const [token, setToken] = useState<ResolvedToken | null>(null);
  const [resolving, setResolving] = useState(false);
  const [free, setFree] = useState<number[]>(initialFree);
  const [selected, setSelected] = useState<number | null>(null);
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const chain = getChain(chainId);

  const refreshColours = useCallback(async () => {
    try {
      const response = await fetch(`/api/colours?war=${encodeURIComponent(war.slug)}`);
      if (!response.ok) return;
      const body = (await response.json()) as { free?: number[] };
      if (Array.isArray(body.free)) setFree(body.free);
    } catch {
      // A failed refresh is not worth an error pill: the list on screen is
      // simply a little older, and the real authority on who gets a colour
      // is the index behind order creation, not this list.
    }
  }, [war.slug]);

  // Kept fresh while the picker is on screen. Somebody choosing a colour is
  // choosing from twenty-four possibilities that other people are taking at
  // the same time, and a stale list turns that into a failed order.
  useEffect(() => {
    if (!token) return;
    const timer = setInterval(() => void refreshColours(), COLOUR_REFRESH_MS);
    return () => clearInterval(timer);
  }, [token, refreshColours]);

  // A colour taken while it was selected stops counting as selected, derived
  // rather than reconciled in an effect: the button would fail on it, and the
  // failure would be a surprise. `chosen` is what the rest of this component
  // reads, so a stale `selected` can never reach the order.
  const chosen = selected !== null && free.includes(selected) ? selected : null;

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
      void refreshColours();
    } catch {
      setError("The lookup did not come back. Try again in a moment.");
    } finally {
      setResolving(false);
    }
  }

  async function startOrder() {
    if (!token || chosen === null) return;
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
          colourSlot: chosen,
          // Sent only when a wallet is connected. An order that names its
          // payer can only be settled by that wallet, which is the stronger
          // position; an order without one is first-to-claim inside its
          // window, and the payment screen says so.
          ...(publicKey ? { payerPubkey: publicKey.toBase58() } : {}),
        }),
      });
      const body = await response.json();
      if (!response.ok) {
        const written = typeof body?.reason === "string" ? REFUSAL_COPY[body.reason] : undefined;
        setError(
          written ??
            (typeof body?.error === "string" ? body.error : "That order could not be started."),
        );
        if (body?.reason === "colour_taken" || body?.reason === "war_full") void refreshColours();
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

      <Step label="2 · Colour">
        {token ? (
          <>
            <ColourPicker
              total={war.maxTokens}
              free={free}
              selected={chosen}
              onSelect={setSelected}
              surface="control"
            />
            <p className="muted text-[12px]">
              {free.length} of {war.maxTokens} colours are still open. A colour belongs to one
              token for the whole war.
            </p>
          </>
        ) : (
          <p className="muted text-[13px]">Find your token first.</p>
        )}
      </Step>

      <Step label="3 · Wallet">
        <WalletConnect />
        <p className="muted text-[12px]">
          {publicKey
            ? "Only this wallet will be able to pay for the order."
            : "You can connect on the next screen instead. An order started without a wallet accepts the first payment that matches it."}
        </p>
      </Step>

      {/* Text lives on panels, never on the bare surround: quiet text needs a
          surface with headroom under DESIGN.md §9, and the surround has none.
          The action and its footnote share one panel for that reason. */}
      <section className="panel bevel flex flex-col gap-3 p-4">
        {error ? (
          <p role="alert" className="bevel-in p-3 text-[13px]" style={{ background: "var(--chrome-control)" }}>
            {error}
          </p>
        ) : null}

        <button
          type="button"
          className="btn-primary px-6 py-3"
          disabled={!token || chosen === null || starting}
          onClick={() => void startOrder()}
        >
          {starting ? "Starting…" : `Continue — $${war.entryPriceUsd} USDC`}
        </button>
        <p className="muted text-[12px]">
          Payment is USDC on Solana, whichever chain the token itself lives on. The colour is held
          for you while the order is open.
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

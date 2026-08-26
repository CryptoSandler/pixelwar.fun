"use client";

import { useMemo, useSyncExternalStore } from "react";
import {
  ConnectionProvider,
  WalletProvider as AdapterProvider,
  useWallet,
} from "@solana/wallet-adapter-react";
import { PhantomWalletAdapter } from "@solana/wallet-adapter-phantom";
import { SolflareWalletAdapter } from "@solana/wallet-adapter-solflare";
import { WalletReadyState } from "@solana/wallet-adapter-base";
import type { Adapter } from "@solana/wallet-adapter-base";
import { shortenAddress } from "../lib/tokens/addresses";

/**
 * The wallet context, mounted once at the root.
 *
 * The connection points at `/api/rpc` — this project's own whitelisting
 * proxy — and never at a provider endpoint. Publishing the endpoint to the
 * browser would hand a paid key to anyone who opens dev tools, and letting
 * the browser call it directly would mean widening `connect-src` past
 * `'self'` for every page on the site. Everything the payment flow asks the
 * cluster for is on the proxy's whitelist.
 *
 * Phantom and Solflare are listed explicitly; Backpack registers itself
 * through the Wallet Standard, which `@solana/wallet-adapter-react` picks up
 * on its own and merges into the same list — there is no Backpack adapter
 * package to install, and its absence here is not an omission.
 */

/**
 * `Connection` refuses a relative URL, and this provider renders on the
 * server too, where `window.location` does not exist. No RPC call is made
 * during a server render, so the value is only ever a placeholder to satisfy
 * the constructor; the browser rebuilds it against the real origin on the
 * first client render.
 */
const SSR_PLACEHOLDER_ENDPOINT = "http://localhost/api/rpc";

export function WalletProvider({ children }: { children: React.ReactNode }) {
  const endpoint = useMemo(
    () =>
      typeof window === "undefined"
        ? SSR_PLACEHOLDER_ENDPOINT
        : new URL("/api/rpc", window.location.origin).toString(),
    [],
  );

  const wallets = useMemo<Adapter[]>(
    () => [new PhantomWalletAdapter(), new SolflareWalletAdapter()],
    [],
  );

  return (
    // `confirmTransactionInitialTimeout` and the websocket a `Connection`
    // would open are both untouched on purpose: nothing in this flow
    // subscribes, so no socket is ever opened, and confirmation is watched
    // by polling `getSignatureStatuses` — which the proxy allows, unlike a
    // websocket, which it could not proxy at all.
    <ConnectionProvider endpoint={endpoint} config={{ commitment: "confirmed" }}>
      <AdapterProvider wallets={wallets} autoConnect onError={reportWalletError}>
        {children}
      </AdapterProvider>
    </ConnectionProvider>
  );
}

/**
 * The three halves of "are we in a browser yet", in the shape
 * `useSyncExternalStore` wants: nothing to subscribe to, true once the client
 * is running, false while the server renders. A `useState` set from an effect
 * would say the same thing by re-rendering after the fact.
 */
const subscribeToNothing = () => () => {};
const onClient = () => true;
const onServer = () => false;

/**
 * Adapter errors arrive here whether or not any component asked for them —
 * a payer dismissing their wallet's approval prompt is the common one. They
 * are surfaced in the payment panel from the call site that caused them;
 * this exists so the ones with no call site do not become unhandled
 * rejections in the console.
 */
function reportWalletError(error: unknown): void {
  console.error("wallet adapter:", error);
}

/**
 * The connect control, in the wallet module because it is wallet plumbing:
 * it knows about readiness states and adapter names, and nothing else in the
 * checkout should have to.
 *
 * Wallets the browser actually has are listed first and can be connected;
 * ones it does not have are still listed, as links to their own site, so a
 * payer with no wallet learns what to install rather than seeing an empty
 * box. Nothing here is brass: connecting is a step, but the action this
 * screen is for is paying.
 */
export function WalletConnect({ disabled = false }: { disabled?: boolean }) {
  const { wallets, wallet, select, disconnect, connect, connected, connecting, publicKey } =
    useWallet();

  /**
   * Which wallets exist is a fact about the browser, and the server has no
   * way to know it: Solflare reports itself connectable with no extension
   * installed at all, so the server's "none found" and the client's list
   * disagree on the first paint. Rendering the list only after mount is what
   * keeps that from being a hydration mismatch — caught in a browser, not by
   * a type.
   */
  const mounted = useSyncExternalStore(subscribeToNothing, onClient, onServer);

  const [installed, notInstalled] = useMemo(() => {
    const ready = wallets.filter(
      (entry) =>
        entry.readyState === WalletReadyState.Installed ||
        entry.readyState === WalletReadyState.Loadable,
    );
    const rest = wallets.filter((entry) => !ready.includes(entry));
    return [ready, rest];
  }, [wallets]);

  if (!mounted) {
    return <p className="numeric text-[12px]">Looking for a wallet…</p>;
  }

  if (connected && publicKey) {
    return (
      <div className="flex flex-wrap items-center gap-3">
        <span className="numeric text-[12px]" title={publicKey.toBase58()}>
          {wallet?.adapter.name}: {shortenAddress(publicKey.toBase58(), 6, 6)}
        </span>
        <button type="button" className="btn-secondary px-3 py-1" onClick={() => void disconnect()}>
          Disconnect
        </button>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap gap-2">
        {installed.map((entry) => (
          <button
            key={entry.adapter.name}
            type="button"
            disabled={disabled || connecting}
            className="btn-secondary flex items-center gap-2 px-3 py-2"
            onClick={() => {
              // `select` is enough: the provider is mounted with autoConnect,
              // so choosing a wallet starts the connection. The explicit
              // `connect` below is for the case where a payer picked a wallet,
              // dismissed its prompt, and wants to try again.
              if (wallet?.adapter.name === entry.adapter.name) void connect();
              else select(entry.adapter.name);
            }}
          >
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={entry.adapter.icon} alt="" aria-hidden width={16} height={16} />
            {entry.adapter.name}
          </button>
        ))}
        {installed.length === 0 ? (
          <p className="text-[13px]">
            No Solana wallet was detected in this browser. Phantom, Solflare and Backpack all work
            here.
          </p>
        ) : null}
      </div>
      {notInstalled.length > 0 ? (
        <p className="text-[12px]">
          Not installed:{" "}
          {notInstalled.map((entry, index) => (
            <span key={entry.adapter.name}>
              {index > 0 ? ", " : ""}
              <a className="underline" href={entry.adapter.url} target="_blank" rel="noreferrer">
                {entry.adapter.name}
              </a>
            </span>
          ))}
        </p>
      ) : null}
      {connecting ? <p className="numeric text-[12px]">Connecting…</p> : null}
    </div>
  );
}

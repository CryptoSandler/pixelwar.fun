"use client";

import { useMemo, useState } from "react";
import { useWallet } from "@solana/wallet-adapter-react";
import { WalletReadyState } from "@solana/wallet-adapter-base";
import { shortenAddress } from "../lib/tokens/addresses";
import { useInBrowser } from "./WalletProvider";

/**
 * The wallet control in the header, on every page.
 *
 * WHY IT IS IN THE HEADER AND NOT IN A FORM. Connecting a wallet is not a
 * step in buying something — it is the state of being signed in, and every
 * Solana site puts it top right because that is where people look for it.
 * `/join` used to carry a "3 · Wallet" step, which said the opposite: that a
 * connection belonged to that one purchase, and that somebody who connected
 * on the board would have to do it again to enter a token.
 *
 * ONE CONNECTION FOR THE WHOLE APP, and it already worked that way: the
 * adapter's provider is mounted once in `app/layout.tsx`, above every page,
 * so the connection survives navigation for free. This button reads that same
 * context — there is no second source of truth to keep in step, and the test
 * that guards it asserts exactly that nothing mounts a provider of its own.
 *
 * NOT BRASS. The accent is for the action a screen is FOR (DESIGN.md I5), and
 * no screen is for connecting a wallet.
 */
export function WalletButton() {
  const { wallets, wallet, select, disconnect, connect, connected, connecting, publicKey } =
    useWallet();
  const mounted = useInBrowser();
  const [open, setOpen] = useState(false);

  const [installed, notInstalled] = useMemo(() => {
    const ready = wallets.filter(
      (entry) =>
        entry.readyState === WalletReadyState.Installed ||
        entry.readyState === WalletReadyState.Loadable,
    );
    return [ready, wallets.filter((entry) => !ready.includes(entry))];
  }, [wallets]);

  /**
   * Before mount the browser's wallet list is unknown and the server must not
   * guess it — same reason `WalletConnect` waits. A control of the right size
   * rather than nothing, so the header does not jump on hydration.
   *
   * A DISABLED BUTTON, NOT A FADED ONE. The first version of this reached for
   * `opacity-60` and was caught by the orphans screen's own assertion that no
   * rendered page contains `opacity` — DESIGN.md §9 and the note above
   * `.btn-primary:disabled` in globals.css say the same thing twice: a filter
   * or an opacity hides the contrast number exactly as well as it hides the
   * ink, and neither is a decision anybody made. `:disabled` is styled with
   * named colours that carry a measured ratio.
   */
  if (!mounted) {
    return (
      <button type="button" className="btn-secondary bevel px-3 py-1.5 text-[12px]" disabled>
        Connect
      </button>
    );
  }

  return (
    <div className="relative">
      <button
        type="button"
        className="btn-secondary bevel px-3 py-1.5 text-[12px]"
        aria-expanded={open}
        aria-haspopup="menu"
        onClick={() => setOpen((value) => !value)}
      >
        {connected && publicKey ? (
          <span className="numeric" title={publicKey.toBase58()}>
            {shortenAddress(publicKey.toBase58(), 4, 4)}
          </span>
        ) : connecting ? (
          "Connecting…"
        ) : (
          "Connect"
        )}
      </button>

      {open ? (
        <div
          role="menu"
          className="panel bevel absolute right-0 z-20 mt-1 flex w-[232px] flex-col gap-0.5 p-1.5"
        >
          {connected && publicKey ? (
            <>
              {/* The full address, because the button shows a truncation and
                  somebody checking which wallet they are on needs the rest.

                  It reads at 11.51:1 on the panel now that `.panel` carries
                  its ink. It rendered at 1.00:1 before — present in the DOM,
                  the exact colour of the surface, and read by the owner as an
                  empty block where an address should be. */}
              <p className="numeric break-all px-1 py-0.5 text-[11px] leading-snug">
                {publicKey.toBase58()}
              </p>
              <button
                type="button"
                role="menuitem"
                className="btn-secondary px-2 py-1 text-left text-[12px]"
                onClick={() => {
                  setOpen(false);
                  void disconnect();
                }}
              >
                Disconnect
              </button>
              <button
                type="button"
                role="menuitem"
                className="btn-secondary px-2 py-1 text-left text-[12px]"
                onClick={() => {
                  // Disconnect and reopen: the adapter has no "switch" that
                  // does not go through disconnecting first, and doing it
                  // silently would leave somebody looking at an unchanged
                  // address wondering whether the click registered.
                  void disconnect();
                  setOpen(true);
                }}
              >
                Change wallet
              </button>
            </>
          ) : (
            <>
              {installed.map((entry) => (
                <button
                  key={entry.adapter.name}
                  type="button"
                  role="menuitem"
                  className="btn-secondary flex items-center gap-2 px-2 py-1 text-left text-[12px]"
                  onClick={() => {
                    setOpen(false);
                    if (wallet?.adapter.name === entry.adapter.name) void connect();
                    else select(entry.adapter.name);
                  }}
                >
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={entry.adapter.icon} alt="" aria-hidden width={14} height={14} />
                  {entry.adapter.name}
                </button>
              ))}
              {installed.length === 0 ? (
                <p className="px-1 py-0.5 text-[12px]">
                  No Solana wallet was detected. Phantom, Solflare and Backpack all work here.
                </p>
              ) : null}
              {notInstalled.length > 0 ? (
                <p className="muted px-1 py-0.5 text-[11px]">
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
            </>
          )}
        </div>
      ) : null}
    </div>
  );
}

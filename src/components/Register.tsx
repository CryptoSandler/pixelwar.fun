"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import { PublicKey } from "@solana/web3.js";
import { getChainForEndpoint } from "@solana/wallet-standard-util";
import { base58Encode } from "../lib/base58";
import { clusterLabel, isLocalHostname, paymentSafety } from "../lib/payments/cluster";
import type { ProxyCluster } from "../lib/payments/cluster";
import { formatSol } from "../lib/payments/config";
import { walletErrorMessage } from "../lib/payments/checkout";
import { buildSolTransfer } from "../lib/payments/transfer";
import { shortenAddress } from "../lib/tokens/addresses";
import { WalletConnect, useInBrowser } from "./WalletProvider";

/**
 * Registering to paint: one transfer, once, ever.
 *
 * WHY THIS SCREEN EXISTS AT ALL, and it is not the checkout's reason. An
 * entry payment buys a community a colour and a place on the board; this buys
 * one person the right to put pixels down. DESIGN.md §1a carries the owner's
 * thesis for charging it — an established Solana gesture, an audience already
 * holding a funded wallet, and anti-sybil that a cleared cookie cannot beat.
 *
 * WHAT IT NEVER SAYS. Not "network fee", not "gas", not "to cover costs".
 * Solana's own fee on this transfer is under a thousandth of a cent and this
 * one is ours; calling it anything else would be a lie about who is paid.
 *
 * THE SAME REFUSAL THE CHECKOUT MAKES. The cluster is classified on the
 * server and arrives as a name — never a URL — and a signing chain that
 * disagrees with it, or either being unknown, blocks the button. A payer who
 * cannot pay asks. A payer who paid on the wrong chain does not know to.
 */

type Phase =
  | { kind: "idle" }
  | { kind: "signing" }
  | { kind: "confirming"; signature: string }
  | { kind: "claiming"; signature: string }
  | { kind: "done"; wallet: string }
  | { kind: "error"; message: string; signature?: string };

/** How long a confirmation is watched before the payer is handed the signature. */
const CONFIRM_TIMEOUT_MS = 45_000;
const STATUS_POLL_MS = 1_500;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export function Register({
  payTo,
  feeLamports,
  proxyCluster,
  onRegistered,
}: {
  /** The receiving wallet, from this deployment's own configuration. */
  payTo: string | null;
  /** What registering costs, as a decimal string of lamports. */
  feeLamports: string;
  /** What this deployment's proxy talks to, classified on the server. */
  proxyCluster: ProxyCluster;
  /** Called with the wallet once the server has recorded the registration. */
  onRegistered: (wallet: string) => void;
}) {
  const { connection } = useConnection();
  const { publicKey, sendTransaction, signMessage, connected } = useWallet();
  const [phase, setPhase] = useState<Phase>({ kind: "idle" });
  const [linkMessage, setLinkMessage] = useState<string | null>(null);
  // Stops the confirmation loop writing state into a component that is no
  // longer on screen — the panel closes the moment a paint succeeds.
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  const inBrowser = useInBrowser();

  const lamports = BigInt(feeLamports);
  const free = lamports === 0n;

  /**
   * The chain the wallet adapter would attach to a signature, derived from
   * the endpoint this browser is pointed at — which is our own proxy. Read on
   * the client because that is where the adapter's own value comes from;
   * compared against the server's classification below, which is the half the
   * browser cannot see.
   */
  const signingChain = inBrowser ? getChainForEndpoint(connection.rpcEndpoint) : "solana:mainnet";
  const localOrigin = inBrowser && isLocalHostname(window.location.hostname);
  const safety = paymentSafety({ localOrigin, signingChain, proxyCluster });

  const claim = useCallback(
    async (signature: string) => {
      setPhase({ kind: "claiming", signature });
      const response = await fetch("/api/register", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ signature }),
      });
      const body = await response.json().catch(() => ({}));

      if (!response.ok) {
        setPhase({
          kind: "error",
          // The signature comes with it: the transfer has landed, and a
          // person whose money moved needs the one string that lets anybody
          // find it — including us, by hand, if this keeps failing.
          message: typeof body?.error === "string" ? body.error : "That did not go through.",
          signature,
        });
        return;
      }

      setPhase({ kind: "done", wallet: body.wallet });
      onRegistered(body.wallet);
    },
    [onRegistered],
  );

  const pay = useCallback(async () => {
    if (!publicKey || !payTo || !safety.ok) return;

    const built = await buildSolTransfer(connection, {
      payer: publicKey,
      recipient: new PublicKey(payTo),
      lamports,
    });
    if (!built.ok) {
      setPhase({ kind: "error", message: built.message });
      return;
    }

    setPhase({ kind: "signing" });
    let signature: string;
    try {
      signature = await sendTransaction(built.transaction, connection, {
        preflightCommitment: "confirmed",
      });
    } catch (error) {
      console.error("register sendTransaction:", error);
      setPhase({ kind: "error", message: walletErrorMessage(error) });
      return;
    }

    setPhase({ kind: "confirming", signature });

    // Polled rather than awaited on `confirmTransaction`, which wants a
    // websocket the RPC proxy cannot carry. Same loop the checkout runs.
    const deadline = Date.now() + CONFIRM_TIMEOUT_MS;
    let landed = false;
    while (Date.now() < deadline && alive.current) {
      try {
        const statuses = await connection.getSignatureStatuses([signature]);
        const status = statuses.value[0];
        if (status?.err) {
          setPhase({
            kind: "error",
            message: "The transfer failed on Solana. Nothing was charged.",
            signature,
          });
          return;
        }
        if (status?.confirmationStatus === "confirmed" || status?.confirmationStatus === "finalized") {
          landed = true;
          break;
        }
      } catch {
        // A failed status check is not a failed payment; keep watching.
      }
      await sleep(STATUS_POLL_MS);
    }
    if (!alive.current) return;

    if (!landed) {
      setPhase({
        kind: "error",
        message:
          "Solana has not confirmed this transfer yet. Keep the signature below — it stays valid, " +
          "and registering with it works as soon as the transfer lands.",
        signature,
      });
      return;
    }

    await claim(signature);
  }, [claim, connection, lamports, payTo, publicKey, safety.ok, sendTransaction]);

  /**
   * The other door: a wallet that already paid, on a browser that has never
   * seen it. Costs nothing and cannot — this path never touches a transfer.
   */
  const link = useCallback(async () => {
    if (!publicKey || !signMessage) return;
    setLinkMessage(null);
    try {
      const challengeResponse = await fetch("/api/register/challenge", { method: "POST" });
      const challenge = await challengeResponse.json().catch(() => ({}));
      if (!challengeResponse.ok) {
        setLinkMessage("Could not start. Try again in a moment.");
        return;
      }

      let signature: Uint8Array;
      try {
        signature = await signMessage(new TextEncoder().encode(challenge.message));
      } catch {
        setLinkMessage("You dismissed the signature request.");
        return;
      }

      const response = await fetch("/api/register/link", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          wallet: publicKey.toBase58(),
          nonce: challenge.nonce,
          signature: base58Encode(signature),
        }),
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) {
        setLinkMessage(typeof body?.error === "string" ? body.error : "That did not work.");
        return;
      }

      setPhase({ kind: "done", wallet: body.wallet });
      onRegistered(body.wallet);
    } catch {
      setLinkMessage("That request did not come back.");
    }
  }, [onRegistered, publicKey, signMessage]);

  if (phase.kind === "done") {
    return (
      <p role="status" aria-live="polite" className="text-[12px]">
        Registered as {shortenAddress(phase.wallet)}. You can paint.
      </p>
    );
  }

  const busy = phase.kind === "signing" || phase.kind === "confirming" || phase.kind === "claiming";
  const blocked = !safety.ok || !payTo;

  return (
    <div className="flex flex-col gap-2">
      <p className="text-[12px]">
        {free
          ? "Painting needs a wallet. Registering is free on this deployment and lasts for every war."
          : `Painting needs a one-time registration of ${formatSol(lamports)} SOL. It is paid once, ` +
            "to pixelwar, and it covers every war from now on."}
      </p>

      {!payTo ? (
        <p className="text-[12px]">
          Registration is not open on this deployment yet.
        </p>
      ) : !safety.ok ? (
        // The disclosure that blocks rather than guesses. Its message names
        // both sides of the disagreement.
        <p role="alert" className="text-[12px]">
          {safety.message}
        </p>
      ) : null}

      {!connected || !publicKey ? (
        <WalletConnect disabled={blocked} />
      ) : (
        <>
          <button
            type="button"
            className="btn-primary bevel px-3 py-1.5"
            disabled={(free ? !signMessage : blocked) || busy}
            // With the fee switched off, registering IS the signature: there
            // is no transfer to build, and asking a wallet to approve a
            // zero-SOL transaction would be a ceremony that still costs the
            // network fee.
            onClick={() => void (free ? link() : pay())}
          >
            {phase.kind === "signing"
              ? "Check your wallet"
              : phase.kind === "confirming"
                ? "Confirming"
                : phase.kind === "claiming"
                  ? "Finishing"
                  : free
                    ? "Register"
                    : `Register — ${formatSol(lamports)} SOL`}
          </button>
          <p className="muted text-[12px]">
            {free
              ? `Signing as ${shortenAddress(publicKey.toBase58())}. It moves no funds.`
              : `Paying from ${shortenAddress(publicKey.toBase58())} on ${clusterLabel(proxyCluster)}.`}
          </p>

          {/* The other door, and it is not the same as the button above: a
              wallet that ALREADY paid, on a browser that has never seen it.
              Hidden when the fee is off, where the button above is already
              this exact flow. */}
          {signMessage && !free ? (
            <button
              type="button"
              className="btn-secondary bevel px-3 py-1.5"
              disabled={busy}
              onClick={() => void link()}
            >
              Already registered? Sign to link this browser
            </button>
          ) : null}
        </>
      )}

      {phase.kind === "error" ? (
        <div className="flex flex-col gap-1">
          <p role="alert" className="text-[12px]">
            {phase.message}
          </p>
          {phase.signature ? (
            <code className="muted break-all text-[11px]">{phase.signature}</code>
          ) : null}
        </div>
      ) : null}

      {linkMessage ? (
        <p role="status" aria-live="polite" className="text-[12px]">
          {linkMessage}
        </p>
      ) : null}
    </div>
  );
}

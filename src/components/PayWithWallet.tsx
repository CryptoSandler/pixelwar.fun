"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import { PublicKey } from "@solana/web3.js";
import { getChainForEndpoint } from "@solana/wallet-standard-util";
import { WalletConnect, useInBrowser } from "./WalletProvider";
import { buildPaymentTransaction } from "../lib/payments/transfer";
import { formatUsdc, usdToBaseUnits } from "../lib/payments/config";
import { clusterLabel, isLocalHostname, paymentSafety } from "../lib/payments/cluster";
import type { ProxyCluster } from "../lib/payments/cluster";
import { CHIP_OUTLINE } from "../lib/wars/chrome";
import { colourForSlot } from "../lib/wars/palette";
import { getChain } from "../lib/tokens/chains";
import { shortenAddress } from "../lib/tokens/addresses";

/**
 * The payment screen: what is about to happen, then the wallet, then the
 * waiting.
 *
 * Everything a payer needs to check is on screen before the button that
 * opens their wallet — who the money goes to, how much, in what, on which
 * network, and for which token and colour. A wallet's own approval dialog
 * shows the same facts, but it shows them at the moment of committing; this
 * shows them while there is still nothing to undo.
 *
 * Nothing here is optimistic. The order is `paid` when the server says it is
 * and not a moment earlier, which is why the last step is polling our own
 * order endpoint rather than trusting a transaction that came back from a
 * wallet.
 */

export type PaymentOrder = {
  id: string;
  status: "pending" | "paid" | "expired" | "failed";
  amountUsd: number;
  /** The receiving wallet's owner address. */
  payTo: string;
  mint: string;
  decimals: number;
  reference: string;
  expiresAt: string;
  /** Set when the order was started from a connected wallet; only it can pay. */
  payerPubkey: string | null;
  token: {
    name: string;
    ticker: string;
    chainId: string;
    contract: string;
    colourSlot: number;
  };
};

type Phase =
  | { kind: "idle" }
  | { kind: "building" }
  | { kind: "signing" }
  | { kind: "confirming"; signature: string }
  | { kind: "verifying"; signature: string }
  | { kind: "paid" }
  | { kind: "error"; message: string; signature?: string };

/** How long to watch the cluster for the transaction before saying so plainly. */
const CONFIRM_TIMEOUT_MS = 90_000;
const STATUS_POLL_MS = 2_000;
/**
 * Gap between `/confirm` attempts. Above the server's own three-second
 * minimum between verifications of one order, deliberately: a client that
 * paces itself exactly at a rate limit spends its attempts on 429s.
 */
const CONFIRM_RETRY_MS = 5_000;
const CONFIRM_MAX_ATTEMPTS = 5;

/**
 * A wallet's own failure, as a sentence.
 *
 * Wallet errors are developer strings — `Transaction simulation failed: Error
 * processing Instruction 1: custom program error: 0x1` is what an underfunded
 * payer gets from a preflight — and DESIGN.md §8 rules that out. The detail
 * still goes to the console, where it is useful; it just does not go on
 * screen as the explanation.
 */
function walletErrorMessage(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error ?? "");
  if (/reject|denied|cancel/i.test(raw)) return "You dismissed the payment in your wallet.";
  if (/insufficient|0x1\b/i.test(raw)) {
    return "The payment did not go through. Check the wallet holds enough USDC, and a little SOL for the fee.";
  }
  return "Your wallet could not send this payment. Try again in a moment.";
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function PayWithWallet({
  order,
  proxyCluster,
}: {
  order: PaymentOrder;
  /**
   * Which cluster this deployment's own RPC proxy talks to, classified on the
   * server. A deployment fact rather than an order fact, which is why it is a
   * sibling prop — and only the classification crosses, never the URL.
   */
  proxyCluster: ProxyCluster;
}) {
  const { connection } = useConnection();
  const { publicKey, sendTransaction, connected } = useWallet();
  const [phase, setPhase] = useState<Phase>(
    order.status === "paid" ? { kind: "paid" } : { kind: "idle" },
  );
  const [remaining, setRemaining] = useState<number>(() =>
    Math.max(0, Date.parse(order.expiresAt) - Date.now()),
  );
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  // The window on the reservation, in monospaced digits so it cannot jitter.
  useEffect(() => {
    if (phase.kind === "paid") return;
    const timer = setInterval(
      () => setRemaining(Math.max(0, Date.parse(order.expiresAt) - Date.now())),
      1000,
    );
    return () => clearInterval(timer);
  }, [order.expiresAt, phase.kind]);

  /** The order's own status, which is the only thing that settles this. */
  const pollOrder = useCallback(async (): Promise<string | null> => {
    try {
      const response = await fetch(`/api/orders/${order.id}`);
      if (!response.ok) return null;
      const body = (await response.json()) as { status?: string };
      return body.status ?? null;
    } catch {
      return null;
    }
  }, [order.id]);

  /**
   * Posts the signature, retrying while the cluster has not caught up yet.
   *
   * Returns the server's `reason` along with its message, because the caller
   * has to tell two failures apart that look identical from here: one where
   * this payer's own money is already accounted for, and one where a second
   * payment of theirs is sitting in the unmatched queue.
   */
  const confirmWithServer = useCallback(
    async (
      signature: string,
    ): Promise<{ ok: true } | { ok: false; message: string; reason?: string }> => {
      let lastMessage = "The payment could not be verified.";
      let lastReason: string | undefined;
      for (let attempt = 0; attempt < CONFIRM_MAX_ATTEMPTS; attempt++) {
        if (attempt > 0) await sleep(CONFIRM_RETRY_MS);
        let response: Response;
        try {
          response = await fetch(`/api/orders/${order.id}/confirm`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ signature }),
          });
        } catch {
          lastMessage = "The verification request did not come back.";
          continue;
        }
        const body = await response.json().catch(() => ({}));
        if (response.ok) return { ok: true };
        lastMessage = typeof body?.error === "string" ? body.error : lastMessage;
        lastReason = typeof body?.reason === "string" ? body.reason : undefined;
        // Only the reasons that can change on their own are worth another
        // attempt. A wrong amount or a wrong payer will still be wrong in
        // five seconds, and each attempt spends the order's verification
        // quota.
        const retryable =
          body?.reason === "not_confirmed" ||
          body?.reason === "no_block_time" ||
          body?.reason === "rpc_unavailable";
        if (!retryable) return { ok: false, message: lastMessage, reason: lastReason };
      }
      return { ok: false, message: lastMessage, reason: lastReason };
    },
    [order.id],
  );

  /**
   * Wraps the whole attempt, because a throw here has nowhere else to go: it
   * is called as `void pay()`, so an unhandled rejection would leave the UI
   * in `building` with the button disabled, nothing on screen, and no way out
   * but a reload. Every individual step below already guards its own failure;
   * this is for the one nobody predicted.
   */
  async function pay() {
    try {
      await attemptPayment();
    } catch (error) {
      console.error("pay:", error);
      setPhase({
        kind: "error",
        message: "Something went wrong preparing this payment. Nothing was charged.",
      });
    }
  }

  async function attemptPayment() {
    if (!publicKey) return;
    setPhase({ kind: "building" });

    let recipient: PublicKey;
    let mint: PublicKey;
    let reference: PublicKey;
    try {
      recipient = new PublicKey(order.payTo);
      mint = new PublicKey(order.mint);
      reference = new PublicKey(order.reference);
    } catch {
      setPhase({ kind: "error", message: "This order's payment details are unreadable." });
      return;
    }

    const built = await buildPaymentTransaction(connection, {
      payer: publicKey,
      recipient,
      mint,
      decimals: order.decimals,
      // The server's own helper, not the same arithmetic written again: it
      // carries a whole-dollar guard this component would otherwise be
      // missing, and a client and a server that compute a price differently
      // is a class of bug worth spending an import to make impossible.
      amountBaseUnits: usdToBaseUnits(order.amountUsd),
      reference,
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
      console.error("sendTransaction:", error);
      setPhase({ kind: "error", message: walletErrorMessage(error) });
      return;
    }

    setPhase({ kind: "confirming", signature });

    // Watched by polling `getSignatureStatuses`, which the RPC proxy allows,
    // rather than by `confirmTransaction`, which would want a websocket the
    // proxy cannot carry.
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
          "and the entry is credited once the payment is found.",
        signature,
      });
      return;
    }

    setPhase({ kind: "verifying", signature });
    const confirmed = await confirmWithServer(signature);
    if (!alive.current) return;
    if (!confirmed.ok) {
      // `signature_reused`, and only that reason. A dropped response to a
      // `/confirm` that actually settled makes the retry post a signature the
      // server has already claimed, and the answer is that this signature is
      // spent — so the one message this flow must never produce, "your
      // payment failed", is what a successful payment would get. Asking the
      // order settles it, and it costs one request.
      //
      // The neighbouring reason must NOT come here, which is why this is not
      // written as "any failure on a paid order". `already_settled` means the
      // order was paid by a DIFFERENT payment and this one is real, unmatched
      // and filed for support (`settle.ts` files it and returns a contact).
      // The order does read `paid` in that case — by someone else's money —
      // so a status check would "confirm" success for a payer who is owed a
      // refund and bury the only message that tells them so.
      if (confirmed.reason === "signature_reused" && (await pollOrder()) === "paid") {
        setPhase({ kind: "paid" });
        return;
      }
      setPhase({ kind: "error", message: confirmed.message, signature });
      return;
    }

    // The server said yes; the order's own row is what says so publicly.
    for (let attempt = 0; attempt < 10 && alive.current; attempt++) {
      if ((await pollOrder()) === "paid") {
        setPhase({ kind: "paid" });
        return;
      }
      await sleep(STATUS_POLL_MS);
    }
    if (alive.current) setPhase({ kind: "paid" });
  }

  const chain = getChain(order.token.chainId);
  // What the wallet will be asked to sign on, read from the same function the
  // adapter uses so the label and the signature cannot drift apart. Only
  // meaningful in a browser: during a server render `rpcEndpoint` is the
  // placeholder `WalletProvider` uses to satisfy `Connection`'s constructor,
  // which would answer for the wrong cluster and mismatch on hydration.
  const inBrowser = useInBrowser();
  const signingChain = getChainForEndpoint(connection.rpcEndpoint);

  // Whether paying here is real at all, decided in one place from three facts
  // that no single one of them can stand in for: where the page is served
  // from, what the wallet will be told, and what this deployment's own proxy
  // actually talks to. The browser cannot see the last of those — every
  // browser sees `/api/rpc` — so it arrives classified from the server.
  //
  // Null until the client is running, because two of the three inputs are
  // browser facts and a server render would answer them wrongly and mismatch
  // on hydration. Null blocks, like every other unsure state here.
  const safety = inBrowser
    ? paymentSafety({
        localOrigin: isLocalHostname(window.location.hostname),
        signingChain,
        proxyCluster,
      })
    : null;
  const blocked = safety === null || !safety.ok;
  const amount = `$${formatUsdc(usdToBaseUnits(order.amountUsd))} USDC`;
  const wrongWallet =
    order.payerPubkey !== null && publicKey !== null && publicKey.toBase58() !== order.payerPubkey;
  // Browser-only, like every other clock-dependent fact here: on the server
  // `remaining` is computed from a clock the client does not share.
  const expired = inBrowser && remaining === 0 && phase.kind !== "paid";
  const busy =
    phase.kind === "building" ||
    phase.kind === "signing" ||
    phase.kind === "confirming" ||
    phase.kind === "verifying";

  if (phase.kind === "paid") {
    return (
      <section className="panel bevel flex flex-col gap-3 p-4">
        <h2 className="section-label">Paid</h2>
        <p className="text-[15px]">
          {order.token.ticker} is in the war, holding colour{" "}
          <span className="numeric">{order.token.colourSlot}</span>.
        </p>
        <Link className="btn-primary inline-block px-6 py-3 text-center" href="/">
          Open the board
        </Link>
      </section>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      <section className="readout bevel-in flex flex-col gap-2 p-4">
        <h2 className="section-label">Check before you sign</h2>
        <Row label="Amount">
          <span className="numeric">{amount}</span>
        </Row>
        <Row label="Network">
          {/* When the deployment's own cluster could not be classified, this
              row does not get to name one. `getChainForEndpoint` answers
              `solana:mainnet` for every endpoint it does not recognise —
              including `/api/rpc`, which is every endpoint this browser ever
              sees — so printing its label here put "Solana mainnet" directly
              above an alert saying the connection could not be identified. The
              alert was right and the row was a guess, and a panel that
              contradicts itself teaches a payer to distrust the half that is
              correct. Uncertainty says so, exactly as CLAUDE.md's rule
              requires of any "which network am I on" surface. */}
          <span className="numeric">
            {!inBrowser
              ? "Checking…"
              : proxyCluster === "unknown"
                ? "Could not be identified"
                : clusterLabel(signingChain)}
          </span>
        </Row>
        <Row label="Recipient">
          <span className="numeric" title={order.payTo}>
            {shortenAddress(order.payTo, 8, 8)}
          </span>
        </Row>
        <Row label="Entry">
          <span className="flex items-center gap-2">
            <span
              aria-hidden
              className="inline-block h-4 w-4"
              style={{
                background: colourForSlot(order.token.colourSlot),
                // Every chip carries its outline, keyed by the surface it is
                // drawn on (DESIGN.md I2). This one sits on the readout.
                outline: `1px solid ${CHIP_OUTLINE.readout}`,
                outlineOffset: "-1px",
              }}
            />
            <span>
              {order.token.name} ({order.token.ticker}) · colour{" "}
              <span className="numeric">{order.token.colourSlot}</span>
            </span>
          </span>
        </Row>
        <Row label="Token">
          <span className="numeric" title={order.token.contract}>
            {chain?.name ?? order.token.chainId} · {shortenAddress(order.token.contract, 6, 6)}
          </span>
        </Row>
        <Row label="Order closes in">
          {/* A countdown cannot be server-rendered: whatever second the server
              picked has passed by the time the client hydrates, and React
              reports the difference as a text mismatch. Caught in a browser
              (React #418), on a page that had rendered correctly a hundred
              times before landing on the wrong side of a second. */}
          <span className="numeric">{inBrowser ? formatRemaining(remaining) : "--:--"}</span>
        </Row>
        {safety && !safety.ok ? (
          // One verdict, one sentence, one disabled button. The hazards are
          // different facts and each has its own wording, but a screen that
          // refuses for two reasons at once still refuses once.
          <p role="alert" className="text-[13px]">
            {safety.message}
          </p>
        ) : null}
      </section>

      <section className="panel bevel flex flex-col gap-2 p-4">
        <h2 className="section-label">Wallet</h2>
        <WalletConnect disabled={busy} />
        {order.payerPubkey ? (
          <p className="muted text-[12px]">
            This order accepts payment only from{" "}
            <span className="numeric">{shortenAddress(order.payerPubkey, 6, 6)}</span>.
          </p>
        ) : (
          <p className="muted text-[12px]">
            This order was started without a wallet, so it accepts the first payment that matches
            it while the window is open.
          </p>
        )}
        {wrongWallet ? (
          <p role="alert" className="text-[13px]">
            The connected wallet is not the one this order names. Connect{" "}
            <span className="numeric">{shortenAddress(order.payerPubkey!, 6, 6)}</span>, or start a
            new order.
          </p>
        ) : null}
      </section>

      {phase.kind === "error" ? (
        <p role="alert" className="panel bevel-in p-3 text-[13px]">
          {phase.message}
          {phase.signature ? (
            <>
              <br />
              <span className="numeric text-[11px] break-all">{phase.signature}</span>
            </>
          ) : null}
        </p>
      ) : null}

      {expired ? (
        <p role="alert" className="panel bevel-in p-3 text-[13px]">
          This order&apos;s window has closed and its colour is open again.{" "}
          <Link className="underline" href="/join">
            Start another
          </Link>
          .
        </p>
      ) : null}

      <button
        type="button"
        className="btn-primary px-6 py-3"
        disabled={blocked || !connected || !publicKey || busy || wrongWallet || expired}
        onClick={() => void pay()}
      >
        {phaseLabel(phase, amount)}
      </button>

      {busy ? (
        <p className="numeric text-[12px]" aria-live="polite">
          {phase.kind === "building" ? "Building the transfer…" : null}
          {phase.kind === "signing" ? "Waiting for your wallet…" : null}
          {phase.kind === "confirming" ? "Waiting for Solana to confirm…" : null}
          {phase.kind === "verifying" ? "Checking the payment…" : null}
        </p>
      ) : null}
    </div>
  );
}

function phaseLabel(phase: Phase, amount: string): string {
  switch (phase.kind) {
    case "building":
      return "Preparing…";
    case "signing":
      return "Approve in your wallet";
    case "confirming":
      return "Confirming…";
    case "verifying":
      return "Verifying…";
    case "error":
      return `Try again — ${amount}`;
    default:
      return `Pay ${amount}`;
  }
}

function formatRemaining(ms: number): string {
  const total = Math.floor(ms / 1000);
  const minutes = String(Math.floor(total / 60)).padStart(2, "0");
  const seconds = String(total % 60).padStart(2, "0");
  return `${minutes}:${seconds}`;
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-wrap items-baseline justify-between gap-2 text-[13px]">
      {/* Full-strength ink, not quiet: this is readout text, and DESIGN.md §9
          asks 8:1 there — a floor the ink clears at 8.40 and nothing lighter
          can. */}
      <span className="section-label">{label}</span>
      {children}
    </div>
  );
}

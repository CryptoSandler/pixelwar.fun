"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import { PublicKey } from "@solana/web3.js";
import { WalletConnect } from "./WalletProvider";
import { buildPaymentTransaction } from "../lib/payments/transfer";
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

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function PayWithWallet({ order }: { order: PaymentOrder }) {
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

  /** Posts the signature, retrying while the cluster has not caught up yet. */
  const confirmWithServer = useCallback(
    async (signature: string): Promise<{ ok: true } | { ok: false; message: string }> => {
      let lastMessage = "The payment could not be verified.";
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
        // Only the reasons that can change on their own are worth another
        // attempt. A wrong amount or a wrong payer will still be wrong in
        // five seconds, and each attempt spends the order's verification
        // quota.
        const retryable =
          body?.reason === "not_confirmed" ||
          body?.reason === "no_block_time" ||
          body?.reason === "rpc_unavailable";
        if (!retryable) return { ok: false, message: lastMessage };
      }
      return { ok: false, message: lastMessage };
    },
    [order.id],
  );

  async function pay() {
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
      amountBaseUnits: BigInt(order.amountUsd) * 10n ** BigInt(order.decimals),
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
      setPhase({
        kind: "error",
        message:
          error instanceof Error && error.message
            ? error.message
            : "The wallet did not send the payment.",
      });
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
  const wrongWallet =
    order.payerPubkey !== null && publicKey !== null && publicKey.toBase58() !== order.payerPubkey;
  const expired = remaining === 0 && phase.kind !== "paid";
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
          <span className="numeric">${order.amountUsd}.00 USDC</span>
        </Row>
        <Row label="Network">
          <span className="numeric">Solana mainnet</span>
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
          <span className="numeric">{formatRemaining(remaining)}</span>
        </Row>
      </section>

      <section className="panel bevel flex flex-col gap-2 p-4">
        <h2 className="section-label">Wallet</h2>
        <WalletConnect disabled={busy} />
        {order.payerPubkey ? (
          <p className="text-[12px] opacity-80">
            This order accepts payment only from{" "}
            <span className="numeric">{shortenAddress(order.payerPubkey, 6, 6)}</span>.
          </p>
        ) : (
          <p className="text-[12px] opacity-80">
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
        disabled={!connected || !publicKey || busy || wrongWallet || expired}
        onClick={() => void pay()}
      >
        {phaseLabel(phase, order.amountUsd)}
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

function phaseLabel(phase: Phase, amountUsd: number): string {
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
      return `Try again — $${amountUsd} USDC`;
    default:
      return `Pay $${amountUsd} USDC`;
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
      <span className="section-label opacity-80">{label}</span>
      {children}
    </div>
  );
}

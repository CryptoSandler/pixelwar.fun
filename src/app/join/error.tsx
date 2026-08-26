"use client";

import { useEffect } from "react";
import Link from "next/link";
import { Cabinet } from "../../components/Cabinet";

/**
 * The boundary for entry and for payment, because one thing on the payment
 * screen can throw where nothing else can catch it.
 *
 * `usdToBaseUnits` guards a whole-dollar amount by throwing, and the payment
 * screen calls it twice: once inside the attempt, which has its own catch, and
 * once while rendering the price label, which does not. A throw during render
 * has nowhere to go but a boundary, and without this file the whole route
 * would fall back to Next's default error page — which says nothing about
 * money, and that is the only thing a payer wants to know here.
 *
 * Deliberately not a repair. It states the one fact worth stating, and offers
 * the only two moves that are safe.
 */
export default function JoinError({
  error,
  retry,
}: {
  error: Error & { digest?: string };
  retry: () => void;
}) {
  useEffect(() => {
    console.error("join:", error);
  }, [error]);

  return (
    <Cabinet label="Entry">
      <section className="panel bevel flex flex-col items-start gap-3 p-6">
        <h1 className="text-[20px] font-medium">This screen could not be shown.</h1>
        <p className="muted text-[13px]">
          Nothing was charged. If a payment was already sent from your wallet, it stays valid and
          the entry is credited once it is found — a signature is never lost by this page failing
          to draw.
        </p>
        <div className="flex flex-wrap gap-2">
          <button type="button" className="btn-secondary px-4 py-2" onClick={() => retry()}>
            Try again
          </button>
          <Link className="btn-secondary px-4 py-2" href="/join">
            Start over
          </Link>
        </div>
      </section>
    </Cabinet>
  );
}

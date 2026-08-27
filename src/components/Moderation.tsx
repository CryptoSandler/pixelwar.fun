"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

/**
 * The operator's panel for one war.
 *
 * WHO CALLS the moderation routes: this component, and nothing else —
 * `POST /api/admin/bans`, `DELETE /api/admin/bans/[id]`,
 * `GET /api/admin/wars/[id]/pixel`, `POST /api/admin/wars/[id]/revert` and
 * `POST /api/admin/wars/[id]/end`.
 *
 * A client component because every one of those is a request with a body or a
 * confirmation, and because the pixel inspector is a loop: look, decide, ban,
 * look again. A page reload between each step is the wrong shape for the one
 * job this screen has, which is being used while something is going wrong.
 */

type Inspection = {
  x: number;
  y: number;
  current: {
    ticker: string | null;
    colourSlot: number;
    paintedAt: string;
    painterKey: string | null;
    ipHash: string | null;
    wallet: string | null;
  } | null;
  timeline: Array<{ seq: number; colourSlot: number; ticker: string | null; paintedAt: string }>;
  earlierPaintersUnavailable: boolean;
};

export type BanRow = {
  id: string;
  keyType: string;
  key: string;
  reason: string | null;
  actor: string;
  live: boolean;
  createdAt: string;
  expiresAt: string | null;
};

/** The default term a ban is offered at. See docs/operations.md — the policy is open. */
const DEFAULT_BAN_HOURS = 24;

function isoInHours(hours: number): string {
  return new Date(Date.now() + hours * 3_600_000).toISOString();
}

export function Moderation({
  warId,
  warSlug,
  warStatus,
  width,
  height,
  bans,
}: {
  warId: string;
  warSlug: string;
  warStatus: string;
  width: number;
  height: number;
  bans: BanRow[];
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  const [px, setPx] = useState("0");
  const [py, setPy] = useState("0");
  const [inspection, setInspection] = useState<Inspection | null>(null);

  const [region, setRegion] = useState({ x0: "0", y0: "0", x1: "0", y1: "0" });
  const [confirmEnd, setConfirmEnd] = useState("");

  async function send(url: string, init: RequestInit): Promise<unknown | null> {
    setBusy(true);
    setMessage(null);
    try {
      const response = await fetch(url, init);
      const body = await response.json().catch(() => ({}));
      if (!response.ok) {
        setMessage(typeof body?.error === "string" ? body.error : "That did not work.");
        return null;
      }
      return body;
    } catch {
      setMessage("That request did not come back.");
      return null;
    } finally {
      setBusy(false);
    }
  }

  async function inspect() {
    const body = (await send(
      `/api/admin/wars/${warId}/pixel?x=${Number(px)}&y=${Number(py)}`,
      { method: "GET" },
    )) as Inspection | null;
    if (body) setInspection(body);
  }

  async function ban(keyType: "painter" | "ip" | "wallet", key: string) {
    const done = await send("/api/admin/bans", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        keyType,
        key,
        reason: `pixel ${inspection?.x},${inspection?.y} in ${warSlug}`,
        // A term, always. The endpoint accepts null for no expiry and this
        // screen never sends it: an unending ban is a sentence, and nothing
        // here writes one by default. See docs/operations.md.
        expiresAt: isoInHours(DEFAULT_BAN_HOURS),
      }),
    });
    if (done) {
      setMessage(`Banned for ${DEFAULT_BAN_HOURS}h.`);
      router.refresh();
    }
  }

  return (
    <section className="flex flex-col gap-4">
      <h2 className="section-label">Moderation — {warSlug}</h2>

      {message ? (
        <p role="status" aria-live="polite" className="readout bevel-in px-3 py-1.5 text-[13px]">
          {message}
        </p>
      ) : null}

      {/* ---- Pixel inspector ---- */}
      <div className="panel bevel flex flex-col gap-2 p-3">
        <h3 className="text-[15px] font-medium">Inspect a pixel</h3>
        <div className="flex flex-wrap items-end gap-2">
          <label className="flex flex-col text-[12px]">
            x
            <input
              className="field numeric w-20 px-2 py-1"
              type="number"
              min={0}
              max={width - 1}
              value={px}
              onChange={(e) => setPx(e.target.value)}
            />
          </label>
          <label className="flex flex-col text-[12px]">
            y
            <input
              className="field numeric w-20 px-2 py-1"
              type="number"
              min={0}
              max={height - 1}
              value={py}
              onChange={(e) => setPy(e.target.value)}
            />
          </label>
          <button type="button" className="btn-secondary bevel px-3 py-1.5" disabled={busy} onClick={inspect}>
            Inspect
          </button>
        </div>

        {inspection ? (
          <div className="flex flex-col gap-2 text-[13px]">
            {inspection.current ? (
              <>
                <p>
                  Held by <strong>{inspection.current.ticker ?? "an unknown token"}</strong>, painted{" "}
                  <span className="numeric">
                    {new Date(inspection.current.paintedAt).toLocaleString()}
                  </span>
                  .
                </p>
                <div className="flex flex-wrap gap-2">
                  {inspection.current.painterKey ? (
                    <button
                      type="button"
                      className="btn-secondary bevel px-3 py-1.5"
                      disabled={busy}
                      onClick={() => ban("painter", inspection.current!.painterKey!)}
                    >
                      Ban this painter
                    </button>
                  ) : null}
                  {inspection.current.ipHash ? (
                    <button
                      type="button"
                      className="btn-secondary bevel px-3 py-1.5"
                      disabled={busy}
                      onClick={() => ban("ip", inspection.current!.ipHash!)}
                    >
                      Ban this address
                    </button>
                  ) : null}
                  {/* The only key that cannot be shed. A painter key is a
                      cookie and an address rotates; a sworn wallet is bound
                      for the war and replacing it costs another token
                      purchase. Reach for this one first when it is there. */}
                  {inspection.current.wallet ? (
                    <button
                      type="button"
                      className="btn-primary px-3 py-1.5"
                      disabled={busy}
                      onClick={() => ban("wallet", inspection.current!.wallet!)}
                    >
                      Ban this wallet
                    </button>
                  ) : null}
                </div>
              </>
            ) : (
              <p className="muted">Nothing is painted here.</p>
            )}

            {inspection.timeline.length > 0 ? (
              <ol className="flex flex-col gap-0.5">
                {inspection.timeline.map((event) => (
                  <li key={event.seq} className="numeric text-[12px]">
                    #{event.seq} · slot {event.colourSlot} · {event.ticker ?? "cleared"} ·{" "}
                    {new Date(event.paintedAt).toLocaleString()}
                  </li>
                ))}
              </ol>
            ) : null}

            {/* The limitation on screen rather than buried. pixel_events has
                never carried painter_key or ip_hash, so an overpainted cell
                has a real timeline and exactly one bannable painter. An
                operator who assumes the list is complete bans the wrong
                person. */}
            {inspection.earlierPaintersUnavailable ? (
              <p className="text-[12px]">
                This pixel was painted more than once. Only the current painter can be banned from
                here — earlier painters were never recorded.
              </p>
            ) : null}
          </div>
        ) : null}
      </div>

      {/* ---- Revert a region ---- */}
      <div className="panel bevel flex flex-col gap-2 p-3">
        <h3 className="text-[15px] font-medium">Clear a region</h3>
        <p className="muted text-[12px]">
          Clears to unpainted. It does not restore a previous owner — nothing records one.
        </p>
        <div className="flex flex-wrap items-end gap-2">
          {(["x0", "y0", "x1", "y1"] as const).map((field) => (
            <label key={field} className="flex flex-col text-[12px]">
              {field}
              <input
                className="field numeric w-20 px-2 py-1"
                type="number"
                min={0}
                value={region[field]}
                onChange={(e) => setRegion({ ...region, [field]: e.target.value })}
              />
            </label>
          ))}
          <button
            type="button"
            className="btn-secondary bevel px-3 py-1.5"
            disabled={busy}
            onClick={async () => {
              const done = (await send(`/api/admin/wars/${warId}/revert`, {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({
                  x0: Number(region.x0),
                  y0: Number(region.y0),
                  x1: Number(region.x1),
                  y1: Number(region.y1),
                }),
              })) as { cleared: number } | null;
              if (done) setMessage(`Cleared ${done.cleared} cells.`);
            }}
          >
            Clear
          </button>
        </div>
      </div>

      {/* ---- Kill switch ---- */}
      <div className="panel bevel flex flex-col gap-2 p-3">
        <h3 className="text-[15px] font-medium">End this war now</h3>
        <p className="muted text-[12px]">
          Stops every further paint immediately. Use when clearing a region is not enough. This
          cannot be undone from here.
        </p>
        {warStatus === "live" ? (
          <div className="flex flex-wrap items-end gap-2">
            <label className="flex flex-col text-[12px]">
              Type the war&apos;s slug to confirm
              <input
                className="field w-56 px-2 py-1"
                value={confirmEnd}
                onChange={(e) => setConfirmEnd(e.target.value)}
                placeholder={warSlug}
              />
            </label>
            {/* Brass is "you can act" (DESIGN.md I5) and this is the most
                consequential action on the screen, so it wears the accent —
                but only once the slug matches. A typed confirmation rather
                than a modal: the operator has to spell out which war. */}
            <button
              type="button"
              className="btn-primary px-4 py-2"
              disabled={busy || confirmEnd !== warSlug}
              onClick={async () => {
                const done = await send(`/api/admin/wars/${warId}/end`, { method: "POST" });
                if (done) {
                  setMessage("War ended.");
                  setConfirmEnd("");
                  router.refresh();
                }
              }}
            >
              End now
            </button>
          </div>
        ) : (
          <p className="muted text-[13px]">
            This war is <span className="numeric">{warStatus}</span>, not live.
          </p>
        )}
      </div>

      {/* ---- Ban list ---- */}
      <div className="panel bevel flex flex-col gap-2 p-3">
        <h3 className="text-[15px] font-medium">Bans</h3>
        {bans.length === 0 ? (
          <p className="muted text-[13px]">Nobody is banned.</p>
        ) : (
          <ul className="flex flex-col gap-1">
            {bans.map((ban) => (
              <li key={ban.id} className="flex items-center justify-between gap-2 text-[12px]">
                <span className="numeric truncate">
                  {ban.live ? "" : "(expired) "}
                  {ban.keyType}:{ban.key.slice(0, 12)}… · {ban.reason ?? "no reason"} · {ban.actor}
                </span>
                <button
                  type="button"
                  className="btn-secondary bevel shrink-0 px-2 py-1"
                  disabled={busy}
                  onClick={async () => {
                    const done = await send(`/api/admin/bans/${ban.id}`, { method: "DELETE" });
                    if (done) router.refresh();
                  }}
                >
                  Lift
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}

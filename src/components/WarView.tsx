"use client";

import { useCallback, useEffect, useState } from "react";
import { Board } from "./Board";
import { PaintButton } from "./PaintButton";
import { TokenRail, type RailToken } from "./TokenRail";
import { WarHud } from "./WarHud";
import { useCanvasStream } from "../hooks/useCanvasStream";

export type WarSummary = {
  slug: string;
  title: string;
  status: string;
  width: number;
  height: number;
  endsAt: string;
};

type LeaderboardToken = {
  id: string;
  name: string;
  ticker: string;
  colourSlot: number;
  owned: number;
  placed: number;
};

const LEADERBOARD_POLL_MS = 2000;

/**
 * The client shell: selected token, cooldown, and the hovered pixel live
 * here. Everything that draws or ticks is delegated to a component that
 * does only that one thing.
 */
export function WarView({ war, tokens: initialTokens }: { war: WarSummary; tokens: RailToken[] }) {
  const { image, version, applyLocal } = useCanvasStream(war.slug);
  const [tokens, setTokens] = useState<RailToken[]>(initialTokens);
  const [selectedId, setSelectedId] = useState<string | null>(initialTokens[0]?.id ?? null);
  const [cooldownUntil, setCooldownUntil] = useState<string | null>(null);
  const [hovered, setHovered] = useState<{ x: number; y: number } | null>(null);
  // The last pixel the pointer was actually over — distinct from `hovered`,
  // which the HUD needs to go blank the instant the pointer leaves the
  // canvas. `target` does NOT clear on pointer-leave: it is what the paint
  // button aims at, and a button gated on `hovered` disables itself the
  // moment the mouse moves off the canvas toward the button, making it
  // unclickable by mouse. `target` survives that trip.
  const [target, setTarget] = useState<{ x: number; y: number } | null>(null);
  const [scale, setScale] = useState(3);
  const [warEnded, setWarEnded] = useState(false);

  // Pick up the painter cookie and any cooldown already in progress.
  useEffect(() => {
    let cancelled = false;
    fetch("/api/session")
      .then((response) => (response.ok ? response.json() : null))
      .then((body: { cooldownUntil: string | null } | null) => {
        if (!cancelled && body) setCooldownUntil(body.cooldownUntil);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  // Keep ownership counts on the rail fresh.
  useEffect(() => {
    let cancelled = false;
    const load = () => {
      fetch(`/api/leaderboard?war=${encodeURIComponent(war.slug)}`)
        .then((response) => (response.ok ? response.json() : null))
        .then((body: { tokens: LeaderboardToken[] } | null) => {
          if (cancelled || !body) return;
          setTokens(
            body.tokens.map((token) => ({
              id: token.id,
              ticker: token.ticker,
              name: token.name,
              colourSlot: token.colourSlot,
              owned: token.owned,
            })),
          );
        })
        .catch(() => {});
    };
    load();
    const timer = setInterval(load, LEADERBOARD_POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [war.slug]);

  // Number keys 1-9 select the first nine tokens.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const index = Number(event.key) - 1;
      if (!Number.isInteger(index) || index < 0 || index > 8) return;
      const token = tokens[index];
      if (token) setSelectedId(token.id);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [tokens]);

  const paintAt = useCallback(
    async (x: number, y: number) => {
      if (!selectedId || warEnded) return;
      try {
        const response = await fetch("/api/paint", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ warSlug: war.slug, x, y, tokenId: selectedId }),
        });

        if (response.status === 200) {
          const body: { seq: number; idx: number; colourSlot: number; cooldownUntil: string } =
            await response.json();
          applyLocal(body.idx, body.colourSlot);
          setCooldownUntil(body.cooldownUntil);
          return;
        }

        // 429: the server is the authority on cooldown, so its answer
        // replaces whatever the client last believed.
        if (response.status === 429) {
          const retryAfterSeconds = Number(response.headers.get("Retry-After")) || 0;
          setCooldownUntil(new Date(Date.now() + retryAfterSeconds * 1000).toISOString());
          return;
        }

        // 409: the war ended while this tab was open. Freeze the canvas
        // rather than let the button keep failing silently.
        if (response.status === 409) {
          setWarEnded(true);
        }
      } catch {
        // A dropped request just leaves the board to the next poll.
      }
    },
    [selectedId, warEnded, war.slug, applyLocal],
  );

  const handleHover = useCallback((point: { x: number; y: number } | null, nextScale: number) => {
    setHovered(point);
    setScale(nextScale);
    if (point) setTarget(point);
  }, []);

  return (
    <main className="relative flex h-screen flex-col bg-zinc-950 text-zinc-50 md:flex-row">
      <aside className="flex shrink-0 gap-3 overflow-x-auto border-b border-zinc-800 p-3 md:h-full md:w-56 md:flex-col md:overflow-x-visible md:overflow-y-auto md:border-b-0 md:border-r">
        <TokenRail tokens={tokens} selectedId={selectedId} onSelect={setSelectedId} />
      </aside>

      <div className="relative flex flex-1 flex-col gap-3 p-3">
        <WarHud hovered={hovered} scale={scale} endsAt={war.endsAt} />

        <div className="relative flex-1 overflow-hidden rounded-lg bg-zinc-800">
          {image ? (
            <Board image={image} version={version} onPaint={paintAt} onHover={handleHover} />
          ) : (
            <div className="grid h-full place-items-center text-sm opacity-70">Loading the canvas...</div>
          )}

          {warEnded ? (
            <div className="absolute inset-0 grid place-items-center bg-black/80 text-center">
              <div>
                <h2 className="text-xl font-semibold">This war has ended.</h2>
                <p className="opacity-80">Painting is closed for {war.title}.</p>
              </div>
            </div>
          ) : null}
        </div>

        <div className="flex justify-center">
          <PaintButton
            cooldownUntil={cooldownUntil}
            disabled={warEnded || !selectedId || !target}
            label="Paint"
            onPaint={() => target && paintAt(target.x, target.y)}
          />
        </div>
      </div>
    </main>
  );
}

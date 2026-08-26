"use client";

import { useCallback, useEffect, useState } from "react";
import { Board } from "./Board";
import { PaintButton } from "./PaintButton";
import { TokenRail, type RailToken } from "./TokenRail";
import { WarHud } from "./WarHud";
import { useCanvasStream } from "../hooks/useCanvasStream";
import { PaintPalette } from "./PaintPalette";

export type WarSummary = {
  slug: string;
  title: string;
  status: string;
  width: number;
  height: number;
  startsAt: string;
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
  /**
   * Which board is on screen: what was painted, or who owns it.
   *
   * The painted board is the default because it is the game; the territory
   * view answers a question the painted board deliberately stopped answering
   * once colours stopped belonging to tokens.
   */
  const [layer, setLayer] = useState<"colour" | "token">("colour");
  const { image, version, applyLocal } = useCanvasStream(war.slug, layer);
  const [tokens, setTokens] = useState<RailToken[]>(initialTokens);
  const [selectedId, setSelectedId] = useState<string | null>(initialTokens[0]?.id ?? null);
  /**
   * The colour this painter paints in — their choice, unrelated to which
   * token they are playing for. Seeded from the selected token's flag so the
   * first paint of a session still looks like the thing you joined, which is
   * a default rather than a rule.
   */
  const [colourSlot, setColourSlot] = useState<number>(initialTokens[0]?.colourSlot ?? 1);
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
  // Seeded from the war's own status: a war the server already knows is
  // scheduled has not started regardless of what any earlier paint attempt
  // said. WarHud flips this back once its own countdown to startsAt expires.
  const [warNotStarted, setWarNotStarted] = useState(war.status === "scheduled");
  const [error, setError] = useState<string | null>(null);

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

  // The round trip is measured at 2.3-2.5s, and cooldownUntil only updates
  // once the response arrives — so a button gated on cooldownUntil alone
  // stays clickable for seconds after the first click. This flag closes that
  // window: it is set before the request goes out and cleared in `finally`,
  // so it covers every response path (200, 429, 409, and anything else)
  // without duplicating the reset in each branch.
  const [inFlight, setInFlight] = useState(false);

  const paintAt = useCallback(
    async (x: number, y: number) => {
      if (!selectedId || warEnded || warNotStarted || inFlight) return;
      setInFlight(true);
      setError(null);
      try {
        const response = await fetch("/api/paint", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ warSlug: war.slug, x, y, tokenId: selectedId, colourSlot }),
        });

        if (response.status === 200) {
          const body: { seq: number; idx: number; colourSlot: number; cooldownUntil: string } =
            await response.json();
          // The optimistic pixel has to match the board that is showing. On
          // the territory layer the byte is the OWNER's slot, not the colour
          // just painted — applying the colour there would draw a pixel that
          // the next diff would silently correct, which is a flicker the
          // painter would read as their paint being rejected.
          const ownerSlot = tokens.find((t) => t.id === selectedId)?.colourSlot;
          applyLocal(body.idx, layer === "token" ? (ownerSlot ?? body.colourSlot) : body.colourSlot);
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

        // 409: either the war ended while this tab was open, or it has not
        // started yet — two different screens, told apart by the reason the
        // server sent back. Freeze the canvas rather than let the button
        // keep failing silently either way.
        if (response.status === 409) {
          const body = await response
            .json()
            .then((value: { reason?: string }) => value)
            .catch(() => null);
          if (body?.reason === "war_not_started") setWarNotStarted(true);
          else setWarEnded(true);
          return;
        }

        // Everything else (403 ban, 400 bad input, 404 unknown war, or
        // anything unexpected) is a real failure the painter has to be
        // told about — a button that does nothing and says nothing is
        // exactly what the 409 handling above exists to avoid.
        const message = await response
          .json()
          .then((body: { error?: string }) => body?.error)
          .catch(() => undefined);
        setError(message ?? "That pixel could not be painted. Please try again.");
      } catch {
        setError("Could not reach the server. Check your connection and try again.");
      } finally {
        setInFlight(false);
      }
    },
    [selectedId, colourSlot, layer, tokens, warEnded, warNotStarted, inFlight, war.slug, applyLocal],
  );

  const handleHover = useCallback((point: { x: number; y: number } | null, nextScale: number) => {
    setHovered(point);
    setScale(nextScale);
    if (point) setTarget(point);
  }, []);

  return (
    <main className="relative flex h-screen flex-col bg-zinc-950 text-zinc-50 md:flex-row">
      <aside className="flex shrink-0 gap-3 overflow-x-auto border-b border-zinc-800 p-3 md:h-full md:w-56 md:flex-col md:overflow-x-visible md:overflow-y-auto md:border-b-0 md:border-r">
        <div className="flex w-full flex-col gap-3">
          <div>
            <p className="text-[11px] uppercase tracking-wide text-[var(--chrome-ink-muted-inverse)]">
              Painting for
            </p>
            <TokenRail tokens={tokens} selectedId={selectedId} onSelect={setSelectedId} />
          </div>

          <div>
            <p className="text-[11px] uppercase tracking-wide text-[var(--chrome-ink-muted-inverse)]">
              Colour
            </p>
            <PaintPalette
              selected={colourSlot}
              onSelect={setColourSlot}
              disabled={warEnded || warNotStarted}
            />
          </div>

          <button
            type="button"
            aria-pressed={layer === "token"}
            onClick={() => setLayer((l) => (l === "token" ? "colour" : "token"))}
            className="px-2 py-1 text-left text-[12px]"
            style={{
              background: "var(--chrome-control)",
              border:
                layer === "token"
                  ? "2px solid var(--chrome-accent)"
                  : "2px solid transparent",
            }}
          >
            {layer === "token" ? "Showing territory" : "Show territory"}
          </button>
        </div>
      </aside>

      <div className="relative flex flex-1 flex-col gap-3 p-3">
        <WarHud
          hovered={hovered}
          scale={scale}
          startsAt={war.startsAt}
          endsAt={war.endsAt}
          notStarted={warNotStarted}
          onStart={() => setWarNotStarted(false)}
        />

        <div className="relative flex-1 overflow-hidden rounded-lg bg-zinc-800">
          {image ? (
            <Board image={image} version={version} onPaint={paintAt} onHover={handleHover} />
          ) : (
            // Quiet text is a named colour, never `opacity` (DESIGN.md §9).
            // MUTED_INK_INVERSE reads 7.26:1 in this well; the `opacity-70`
            // it replaced rendered 7.76:1 and recorded that nowhere.
            <div className="grid h-full place-items-center text-sm text-[var(--chrome-ink-muted-inverse)]">
              Loading the canvas...
            </div>
          )}

          {warNotStarted ? (
            <div className="absolute inset-0 grid place-items-center bg-black/80 text-center">
              <div>
                <h2 className="text-xl font-semibold">This war has not started yet.</h2>
                <p className="text-[var(--chrome-ink-muted-inverse)]">
                  Painting opens for {war.title} soon.
                </p>
              </div>
            </div>
          ) : warEnded ? (
            <div className="absolute inset-0 grid place-items-center bg-black/80 text-center">
              <div>
                <h2 className="text-xl font-semibold">This war has ended.</h2>
                <p className="text-[var(--chrome-ink-muted-inverse)]">
                  Painting is closed for {war.title}.
                </p>
              </div>
            </div>
          ) : null}
        </div>

        <div className="flex flex-col items-center gap-2">
          <PaintButton
            cooldownUntil={cooldownUntil}
            disabled={warEnded || warNotStarted || !selectedId || !target || inFlight}
            label="Paint"
            onPaint={() => target && paintAt(target.x, target.y)}
          />
          {error ? (
            <p
              role="status"
              aria-live="polite"
              className="rounded-md bg-red-950 px-3 py-1.5 text-sm text-red-200"
            >
              {error}
            </p>
          ) : null}
        </div>
      </div>
    </main>
  );
}

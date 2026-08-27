"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { Board } from "./Board";
import { PaintButton } from "./PaintButton";
import { TokenRail, type RailToken } from "./TokenRail";
import { Scoreboard } from "./Scoreboard";
import { WarClock } from "./WarClock";
import { WarHud } from "./WarHud";
import { useCanvasStream } from "../hooks/useCanvasStream";
import { CHIP_OUTLINE } from "../lib/wars/chrome";
import { colourForSlot } from "../lib/wars/palette";
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
  /**
   * Whether the rail is showing, below 960px where it is a sheet over the
   * board (DESIGN.md §5). Ignored at wider widths, where the rail is always
   * a column and this never applies.
   */
  const [railOpen, setRailOpen] = useState(false);
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
    /**
     * THE CABINET. A header carrying the wordmark, a rail that is now a
     * scoreboard, and the board mounted in a single frame.
     *
     * This screen used to be `bg-zinc-950` with a rounded well and zinc
     * borders — the design system existed in globals.css and chrome.ts and
     * simply was not on the one page anybody looks at. Nothing here is a new
     * decision; it is DESIGN.md applied.
     */
    <main className="flex h-screen flex-col" style={{ background: "var(--chrome-surround)" }}>
      <header className="header-bar bevel flex shrink-0 items-center justify-between gap-3 px-4 py-2.5">
        {/* Brass, and one of exactly three places the accent is allowed
            (DESIGN.md I5). A visitor who lands here with no context reads the
            name of the thing before anything else. */}
        <span
          className="shrink-0 text-[16px] font-medium tracking-[0.14em]"
          style={{ color: "var(--chrome-accent)" }}
        >
          PIXELWAR
        </span>

        {/* The clock rides in the header below 960px, where the rail is a
            sheet. It does not go INTO the sheet: the ending is the stake, and
            a stake behind a button is a stake nobody sees. */}
        <span className="rail:hidden">
          <WarClock
            compact
            startsAt={war.startsAt}
            endsAt={war.endsAt}
            notStarted={warNotStarted}
            ended={warEnded}
            onStart={() => setWarNotStarted(false)}
          />
        </span>

        <span className="section-label hidden truncate rail:inline">{war.title}</span>

        <span className="flex shrink-0 items-center gap-2">
          {/*
            THE ACTION THAT BILLS, and it was a `muted` underlined link at the
            foot of the rail — below the fold on a phone, and styled as a
            footnote on a desktop. A community leader arriving to find rivals
            on the board had no visible way in.

            Brass because it is an action (DESIGN.md I5, which is a principle
            and not a cap of three). It sits in the header rather than beside
            Paint on purpose: two brass controls for two different people, in
            two different zones. Paint is for whoever is painting; this is for
            whoever wants a colour of their own.
          */}
          <Link href="/join" className="btn-primary px-3 py-1.5">
            Add your token
          </Link>

          <button
            type="button"
            className="btn-secondary bevel px-3 py-1 rail:hidden"
            aria-expanded={railOpen}
            onClick={() => setRailOpen((open) => !open)}
          >
            {railOpen ? "Close" : "War"}
          </button>
        </span>
      </header>

      <div className="relative flex min-h-0 flex-1 flex-col rail:flex-row">
        {/*
          THE BOARD NEVER GIVES (DESIGN.md §5).

          Below 960px this <aside> is `.rail-sheet` — absolutely positioned
          over the board — so the board's box is byte-identical whether the
          rail is open or shut. It used to be a block in a column, which meant
          the clock, the scoreboard, the token list and the palette all took
          their height first and the board got whatever was left. On a phone
          that made the canvas the smallest thing on screen.

          At 960px and up it goes back to being a 280px column and `railOpen`
          stops mattering.
        */}
        <aside
          className={`panel bevel shrink-0 flex-col gap-3 overflow-y-auto p-3 rail:static rail:flex rail:w-[280px] ${
            railOpen ? "rail-sheet flex" : "hidden"
          }`}
        >
          {/* THE CLOCK, and it is the event. It used to be six words of
              unstyled mono in a corner strip above the canvas, which is where
              a page puts a build number. A war is a thing with an ending, and
              the ending is most of why anybody is watching. */}
          <div className="hidden rail:block">
            <WarClock
              startsAt={war.startsAt}
              endsAt={war.endsAt}
              notStarted={warNotStarted}
              ended={warEnded}
              onStart={() => setWarNotStarted(false)}
            />
          </div>

          <section className="flex flex-col gap-1">
            <h2 className="section-label">Board</h2>
            <Scoreboard
              tokens={tokens}
              boardPixels={war.width * war.height}
              selectedId={selectedId}
              onSelect={setSelectedId}
            />
          </section>

          <section className="flex flex-col gap-1">
            <h2 className="section-label">Painting for</h2>
            <TokenRail tokens={tokens} selectedId={selectedId} onSelect={setSelectedId} />
          </section>

          <section className="flex flex-col gap-1">
            <h2 className="section-label">Colour</h2>
            <PaintPalette
              selected={colourSlot}
              onSelect={setColourSlot}
              disabled={warEnded || warNotStarted}
            />
          </section>

          <button
            type="button"
            aria-pressed={layer === "token"}
            onClick={() => setLayer((l) => (l === "token" ? "colour" : "token"))}
            className="btn-secondary bevel px-3 py-1.5 text-left"
            style={layer === "token" ? { outline: "2px solid var(--chrome-accent)" } : undefined}
          >
            {layer === "token" ? "Showing territory" : "Show territory"}
          </button>

        </aside>

        {/* Margins in service of the canvas: the board takes every pixel the
            rail does not, and is the only thing that grows. */}
        <div className="flex min-h-0 min-w-0 flex-1 flex-col gap-2 p-3">
          <WarHud hovered={hovered} scale={scale} />

          <div className="board-frame relative min-h-0 flex-1">
            {image ? (
              <Board image={image} version={version} onPaint={paintAt} onHover={handleHover} />
            ) : (
              /* Full ink, not muted. The board ground carries MUTED_INK_INVERSE
                 at 6.54:1, under DESIGN.md §9's body floor of 7 — see
                 MUTED_INK_INVERSE_SURFACES, which deliberately omits it. This
                 line was muted in the restyle's first draft and the invariant
                 caught it. */
              <div className="grid h-full place-items-center text-[13px] text-[var(--chrome-ink-inverse)]">
                Loading the canvas...
              </div>
            )}

            {warNotStarted || warEnded ? (
              /* A SOLID face, not a translucent scrim. An overlay at 88% over
                 the board composites to a colour nobody measured, which is the
                 same defect as quieting text with opacity one layer out. The
                 header ground is a declared surface, carries full ink at
                 11.51:1 and muted at 7.55:1, and is on the list that says so. */
              <div
                className="absolute inset-0 grid place-items-center text-center"
                style={{ background: "var(--chrome-header)" }}
              >
                <div className="flex flex-col gap-1 px-4">
                  <h2 className="text-[20px] font-medium text-[var(--chrome-ink-inverse)]">
                    {warNotStarted ? "This war has not started yet." : "This war has ended."}
                  </h2>
                  <p className="text-[13px] text-[var(--chrome-ink-muted-inverse)]">
                    {warNotStarted
                      ? `Painting opens for ${war.title} soon.`
                      : `Painting is closed for ${war.title}.`}
                  </p>
                </div>
              </div>
            ) : null}
          </div>

          <div className="flex shrink-0 flex-col gap-2">
            {/*
              WHAT PRESSING THIS WILL DO, next to the thing that does it.

              Below 960px the palette and the token list live in the sheet, so
              without this a painter on a phone taps Paint without seeing what
              colour is loaded or who it counts for. It earns its place at
              every width for the same reason: "what happens if I press this"
              is the question a primary action should not make you go and look
              up.
            */}
            <p className="readout bevel-in flex items-center gap-2 px-3 py-1.5 text-[13px]">
              <span
                aria-hidden
                className="h-4 w-4 shrink-0"
                style={{
                  background: colourForSlot(colourSlot),
                  // I2: the chip carries the outline for the surface it is on,
                  // and this one is on the readout. Without it #AEC0DE swallows
                  // nothing but the outline is what stops #FFFFFF doing so.
                  outline: `1px solid ${CHIP_OUTLINE.readout}`,
                  outlineOffset: "-1px",
                }}
              />
              <span className="truncate">
                Painting for{" "}
                <strong>{tokens.find((t) => t.id === selectedId)?.ticker ?? "no token"}</strong>
              </span>
            </p>

            <PaintButton
              cooldownUntil={cooldownUntil}
              disabled={warEnded || warNotStarted || !selectedId || !target || inFlight}
              label="Paint"
              onPaint={() => target && paintAt(target.x, target.y)}
            />
            {error ? (
              <p role="status" aria-live="polite" className="readout bevel-in px-3 py-1.5 text-[13px]">
                {error}
              </p>
            ) : null}
          </div>
        </div>
      </div>
    </main>
  );
}

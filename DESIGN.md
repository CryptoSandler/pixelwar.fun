# pixelwar.fun — Design

**Direction C, "Cabinet".** One screen, one board, one thing to do.

> **Base:** [`design-md/nintendo-2001`](https://github.com/VoltAgent/awesome-design-md) from
> VoltAgent's `awesome-design-md`, commit `8147538`. **MIT licence**, verified by reading
> `LICENSE` in the clone (Copyright © 2026 VoltAgent) rather than by trusting a
> label. Two other directions were built and measured against the same
> invariants before this one was chosen; both are kept in [docs/design/](docs/design/) so the
> comparison survives the decision.

The invariants in §7 are not advice. Each one is a test in
[chrome.test.ts](src/lib/wars/__tests__/chrome.test.ts), and the values they
police live in [chrome.ts](src/lib/wars/chrome.ts). A colour swapped for a
prettier one that happens to collide fails the suite at the moment it is
introduced.

---

## 1. Vision

A war is 48 to 72 hours long, and for all of it the board is the only thing
that matters. Twenty-four communities each hold one colour; painting is free;
the leaderboard moves while you watch. Everything the interface does is in
service of two questions a visitor asks in the first three seconds: *what is
happening on this board*, and *how do I add to it*.

So the chrome is a cabinet, not a canvas. It is the console around an arcade
screen: sturdy, quiet, obviously a machine, and never competing for attention
with the thing it houses. The visual language is early-2000s console UI —
bevelled panels, hard corners, a brass action key — because that language is
honest about being an instrument, and because a machine that looks like a
machine makes the board look like art.

**What this is not.** Not a dashboard. Not a trading terminal. Not a
crypto-native dark theme with glows and gradients, which would put the chrome
in direct competition with twenty-four saturated colours and lose.

---

## 2. Colour

Two separate colour systems share one screen and must never be confused.

**The canvas palette** — twenty-four colours, one per token, plus the ground.
Defined in [palette.ts](src/lib/wars/palette.ts). These are the r/place 2022
values, which every clone converged on because they stay distinguishable at
one-pixel size. **They belong to tokens.** A community's colour is its identity
and its scoreboard.

| Role | Value | Note |
| --- | --- | --- |
| Token slots 1–24 | see `PALETTE` | Never used by chrome |
| Empty pixel (slot 0) | `#2E2E38` | A desaturated slate. No token is grey, so grey can only mean unpainted. |

**The chrome palette** — everything the application paints for itself. Defined
in [chrome.ts](src/lib/wars/chrome.ts).

| Role | Value | Chroma | Nearest token |
| --- | --- | --- | --- |
| Surround | `#A8B1C6` | 0.118 | 94 away |
| Panel / control face | `#DEDEDE` | 0.000 | neutral |
| Readout | `#AEC0DE` | 0.188 | 104 away |
| Header | `#21242E` | 0.051 | neutral |
| **Accent (brass)** | `#B87A1E` | 0.604 | 90 away |
| Chip outline, light surfaces | `#21242E` | — | — |
| Chip outline, dark surfaces | `#F2F3F7` | — | — |

**Brass is the only saturated thing in the chrome, and it means "you can act".**
The Paint button, the selected swatch, the wordmark. Nothing else. One accent
used for one purpose cannot be mistaken for a token, because no token ever
appears as a large filled control.

### How these values were chosen

Not by taste. Sweeping the 24-bit cube against the palette under three
simultaneous filters — distance ≥ 80 from every token and the ground, chroma
low enough not to compete, contrast ≥ 4.5:1 so the colour can carry text —
leaves a specific family, and the accents are drawn from it. Of twelve
hand-picked candidates tried first, **only two cleared the distance**: brass at
90 and warm stone at 91. Miro's canary `#FFD02F`, an obvious choice on
instinct, sits **8 units** from token slot 4 — the same colour to any eye that
is not measuring.

---

## 3. Typography

Two families, both Google Fonts, loaded through `next/font/google`. **No system
font stacks**: a face that resolves differently per machine is a design that
does not exist.

| Family | Role | Why |
| --- | --- | --- |
| **Jost** | Wordmark, headings, token tickers, buttons | A geometric grotesque in the Futura lineage. Arcade-marquee character without costume. |
| **IBM Plex Mono** | Every number, coordinate, countdown, and status readout | Pairs with Jost's geometry. Tabular by default, so a live leaderboard does not jitter as counts change. |

**The rule that matters: every number is monospaced.** Pixel counts, the
countdown, coordinates, zoom. A leaderboard whose digits shift width while it
updates reads as unstable, and this board updates every 1.5 seconds.

| Token | Size | Weight | Tracking |
| --- | --- | --- | --- |
| Wordmark | 16px | 500 | `.14em` |
| Section label | 11px | 600 | `.14em`, uppercase, mono |
| Token ticker | 13px | 500 | `.06em` |
| Numeric | 12px | 400 | mono, tabular |
| Button | 13px | 600 | `.05em` |

---

## 4. Form

| Property | Value | Reasoning |
| --- | --- | --- |
| Corner radius | **0** everywhere | The cabinet has no soft edges. Softness would put the chrome and the pixel grid in the same visual family, and the grid should be the only hard thing that matters. |
| Depth | Two-tone 2px bevels — light top/left, dark bottom/right | Console, not web. Costs nothing to render and reads instantly as "physical control". |
| Shadows | None | A bevel already says raised. A shadow would say floating, which is a different and wrong claim. |
| Board frame | 3px `#21242E`, inset 2px `#60619C` | The board is mounted, not embedded. |
| Grid | 1px `#21242E` at ≥ 8× zoom only | Below 8× the grid is noise on top of art. |

---

## 5. Layout

```
┌──────────────────────────────────────────────────────────────┐
│  HEADER — wordmark · war status                              │
├───────────────┬──────────────────────────────────────────────┤
│  LEADERBOARD  │           READOUT — coords · countdown       │
│               │  ┌────────────────────────────────────────┐  │
│  chip ticker  │  │                                        │  │
│       count   │  │              THE BOARD                  │  │
│       bar     │  │              200 × 200                  │  │
│               │  │                                        │  │
│               │  └────────────────────────────────────────┘  │
│               │   PAINT BAR — token swatches      [ PAINT ]  │
│  footnote     │                                              │
└───────────────┴──────────────────────────────────────────────┘
```

Fixed 280px rail, board centred in the remaining space. The board never
reflows: it is a fixed-ratio square and everything else yields to it. Below
960px the rail collapses to a sheet over the board rather than squeezing it —
**the board's size is never the thing that gives.**

**Reference renders:** [c-cabinet.png](docs/design/c-cabinet.png) is this
direction. [a-instrument.png](docs/design/a-instrument.png) and
[b-workshop.png](docs/design/b-workshop.png) are the two rejected alternatives,
kept for the record; both were generated by
[gen.mjs](docs/design/gen.mjs). Note that the archived
alternatives still reference system fonts — they predate the rule in §3 and are
not built.

---

## 6. Motion

Motion is a sprite, not an animation. Steps, not curves.

| Event | Behaviour |
| --- | --- |
| Select a token | Immediate. Bevel inverts, outline goes brass. No transition. |
| Paint a pixel | Optimistic; the pixel appears at once and reconciles on the next diff. |
| Cooldown | A segmented bar losing one block at a time, never a smooth drain. |
| Board diff arrives | Changed pixels swap with no fade. A fade would imply uncertainty about who owns a pixel, and ownership is exact. |
| Leaderboard reorder | 2-frame step, ~120ms total. |
| Hover | Bevel lightens. No scale, no lift. |

**`prefers-reduced-motion: reduce` is honoured throughout**, and it is cheap
here because the design is already step-based:

- The cooldown bar jumps between block counts rather than stepping through them.
- Leaderboard reordering is instant — rows appear in their new positions.
- No element translates, scales, or rotates under any circumstances.
- Colour and content changes still apply: reduced motion must never mean
  reduced information.

Implement as a single guarded block, never per-component:

```css
@media (prefers-reduced-motion: reduce) {
  *, *::before, *::after {
    animation-duration: 0.01ms !important;
    animation-iteration-count: 1 !important;
    transition-duration: 0.01ms !important;
  }
}
```

---

## 7. Invariants

Every rule here is enforced by
[chrome.test.ts](src/lib/wars/__tests__/chrome.test.ts). Changing a colour
without changing these tests fails the suite.

### I1 — The chrome never claims a token's colour

No deliberately-coloured chrome surface may sit within
`CHROME_TOKEN_DISTANCE` (80) of any of the twenty-four.

> *Test:* `signatureColours()` — the accent, the surround, the readout — each
> measured against all of `PALETTE`. A control test asserts the guard fires,
> using Miro's canary at distance 8.

**This rule binds saturated chrome only, and that is deliberate.** Neutrals
cannot obey it: the palette contains pure white and pure black, so a light
panel is necessarily near one and a dark header near the other — and
`CANVAS_GROUND` itself, already settled and correct, sits 69 from `#6D482F`. A
rule that the design's own agreed decisions fail is not strict, it is broken.
Neutrals are protected by I2 instead.

### I2 — Every token chip is visible on every surface it is drawn on

A chip is the small filled square standing for a token. On each surface in
`CHROME_SURFACES`, the chip's outline must clear `OUTLINE_SURFACE_DISTANCE`
(60) from that surface.

> *Test:* every surface checked against its declared outline; plus a dedicated
> case for `#FFFFFF` and `#000000`, the two tokens that would otherwise
> disappear on light and dark chrome respectively; plus an assertion that every
> surface has a declared outline, so a new surface cannot be added silently.

**Why this exists.** A rejected direction with warm-white chrome erased its
white token completely — in the leaderboard and the paint bar at once. Nothing
in the code was wrong; the render is what caught it. The fill cannot solve
this, because the fill is the token's colour and is not ours to change. The
outline can, because it is ours.

### I3 — The empty pixel reads as empty

`CANVAS_GROUND` is no token's colour, is neither pure white nor pure black, and
is a neutral (chroma < 0.1).

> *Test:* all three conditions asserted directly. No token in `PALETTE` is
> grey, so grey can only ever mean unpainted.

### I4 — The chrome never out-shouts the canvas

Every surface in `CHROME_SURFACES` must have lower chroma than the least
saturated token that is a colour at all.

> *Test:* ceiling derived at runtime from `PALETTE` (0.243, the pale yellow
> `#FFF8B8`) rather than hard-coded, so re-palettising the board automatically
> re-tightens the chrome. Achromatic tokens are excluded from the minimum —
> including them would pin the ceiling at zero and forbid every surface,
> including the ones already in use.

This invariant is what set the surround. The original periwinkle sat at 0.25
chroma across the largest area on screen; the replacement is 0.118 **and its
distance from the nearest token improved from 83 to 94.** The readout failed
the same rule at 0.282 and was replaced at 0.188.

### I5 — The accent means action, and only action

`ACCENT` appears on the primary button, the selected swatch, and the wordmark.
Never on a chip, a bar, a border, or any element that represents a token.

> *Test:* partially enforced — `chroma(ACCENT) > chroma(surround)` asserts it
> stays the loudest chrome. Placement is a review rule, not yet a test, because
> the components it governs are built in Batch B tasks 9 and 10. **This is the
> one invariant currently weaker than its statement.**

---

## 8. Copy

All user-facing copy is **English**, in every file in this repository.

Plain and specific over clever. The board is doing the entertaining; the
interface's job is to be understood on the first read by someone who has never
seen r/place.

| Say | Not |
| --- | --- |
| "Pixels held right now" | "Score" |
| "41:13:37 left" | "Time remaining: 41h 13m 37s" |
| "That colour is taken" | "Error: slot unavailable" |
| "Paint" | "Submit" / "Place pixel" |

Never imply a pixel is permanent. Overpainting is the game — the leaderboard
counts pixels **held**, not pixels **placed**, and the copy must never suggest
otherwise.

---

## 9. Accessibility

- Every interactive element reachable by keyboard; the paint bar is a single
  tab stop with arrow-key traversal between swatches.
- Focus is a 2px brass outline offset 2px. Never removed.
- Token identity is **never carried by colour alone** — the ticker is always
  present beside the chip, in the leaderboard and the paint bar both. A
  colour-blind visitor loses nothing but the board's aesthetics.
- Readout text holds ≥ 8:1 against its surface; body text ≥ 7:1.
- `prefers-reduced-motion` as specified in §6.
- The board itself is an image of a shared artwork. It carries a live text
  summary — leader, pixel count, time left — so a screen reader gets the state
  without the pixels.

---

## 10. Attribution

Base design tokens adapted from
[`awesome-design-md`](https://github.com/VoltAgent/awesome-design-md) by
VoltAgent, commit `8147538`, used under the **MIT Licence**:

```
MIT License

Copyright (c) 2026 VoltAgent

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.
```

No code or assets were copied from any r/place clone. The canvas palette is the
r/place 2022 colour list, which is a set of values rather than a work; the
research behind that decision, and what was deliberately not taken from
existing clones, is recorded in [docs/references.md](docs/references.md).

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
that matters. Communities compete for territory; anyone may paint in any of
the twenty-four colours; painting is free; the scoreboard moves while you
watch. Everything the interface does is in
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

**The canvas palette** — twenty-four colours anyone may paint in, plus the
ground. Defined in [palette.ts](src/lib/wars/palette.ts). These are the
r/place 2022 values, which every clone converged on because they stay
distinguishable at one-pixel size.

**They no longer belong to tokens, and that changed after this document was
first written.** A colour was a token's identity when a canvas byte was a
palette slot and a palette slot was a token. Painting is free of that now:
attribution rides on `pixels.war_token_id` and the colour on the board says
nothing about who owns a pixel (migration 007). What a token keeps is a
FLAG — its slot in this list, which stands for it on the scoreboard and in
the territory view, and which is the only place a token's colour still
appears at size.

| Role | Value | Note |
| --- | --- | --- |
| Palette slots 1–24 | see `PALETTE` | Free to paint with. Never used by chrome. |
| Token flag | `flagColourForSlot` | The same list, wrapped: past 24 tokens two flags repeat. See [operations.md](docs/operations.md). |
| Empty pixel (slot 0) | `#2E2E38` | A desaturated slate. No token is grey, so grey can only mean unpainted. It is also the one slot `paintPixel` refuses, so nobody can blank a pixel by painting the ground. |

**The chrome palette** — everything the application paints for itself. Defined
in [chrome.ts](src/lib/wars/chrome.ts).

| Role | Value | Chroma | Nearest token |
| --- | --- | --- | --- |
| Surround | `#A8B1C6` | 0.118 | 94 away |
| Panel / control face | `#DEDEDE` | 0.000 | neutral |
| Readout | `#AEC0DE` | 0.188 | 104 away |
| Header | `#21242E` | 0.051 | neutral |
| **Accent (brass)** | `#B1923B` | 0.463 | 100 away |
| Chip outline, light surfaces | `#21242E` | — | — |
| Chip outline, dark surfaces | `#F2F3F7` | — | — |
| Muted ink (panels only) | `#3A3F4D` | 0.075 | 60 away |
| Muted ink, dark faces | `#B0B5C2` | 0.071 | 87 away |
| Disabled ink (panels only) | `#6B7285` | 0.102 | 85 away |
| Disabled button face | `#909090` | 0.000 | 92 away |

**Quieter text is a colour, never opacity or a filter.** `#21242E` at 80% renders 5.37:1 on
the readout against a floor of 8:1 — the colour still passes every test in this
file while the element on screen fails, which is the whole failure mode I6
exists for. The quiet step exists twice, once per polarity, for the same
reason the ink does: `#3A3F4D` reads **1.89:1** on the board's dark chrome, so
a dark face needs `#B0B5C2` — 9.70:1 there and 7.26:1 in the board well —
rather than a lighter version of a colour that was never going to work. The muted ink is measured like any other colour, and it is declared
only for panel and control faces: the readout and the surround have no headroom
at all, since the full ink itself reads 8.40 and 7.20 against floors of 8 and 7.
Text that needs to be quiet does not belong on those two surfaces. A disabled
control's label is the one step quieter than muted — 3.57:1, its own named
colour, because "WCAG exempts disabled controls" is a reason to choose a value
deliberately rather than a reason to leave it composited. The disabled primary
button is the same decision on the other side of the control: a named face
carrying the full ink at 4.85:1, rather than the accent run through a filter
that rendered 4.33:1 and said so nowhere.

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
│  CLOCK        │           READOUT — coords · zoom            │
│  SCOREBOARD   │                                              │
│               │  ┌────────────────────────────────────────┐  │
│  chip ticker  │  │                                        │  │
│       bar     │  │              THE BOARD                  │  │
│       share%  │  │              200 × 200                  │  │
│               │  │                                        │  │
│               │  └────────────────────────────────────────┘  │
│  PAINTING FOR │                                              │
│  COLOUR       │              [ PAINT — cooldown inside ]     │
│  footnote     │                                              │
└───────────────┴──────────────────────────────────────────────┘
```

The war clock sits at the top of the rail, not in the readout strip: a war is
a thing with an ending and the ending is most of why anybody is watching, so
it is set at 28–34px in tabular mono rather than filed next to the zoom
level. The scoreboard below it is a bar per token, scaled to the leader
rather than to the board — early in a war every share is a fraction of a
percent and bars drawn against 40,000 cells are all zero width, which would
leave the scoreboard blank for the hours when watching it is most
interesting. The percentage beside each bar carries the absolute truth.

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
`CHIP_SURFACES` — every surface a chip is drawn on, of either polarity — the
chip's outline must clear `OUTLINE_SURFACE_DISTANCE` (60) from that surface.

**This asks a wider list than the other invariants do, and that is the point.**
`CHIP_SURFACES` is `CHROME_SURFACES` plus `BOARD_SURFACES`, the Batch A dark
faces the board still renders on. Those faces are rightly exempt from §4's
chroma ceiling and I1's distance rule — the design did not choose them, so
holding them to rules about what the design may choose is meaningless. Chip
visibility is a different question. A token that vanishes into the surface
behind it has vanished whether or not anybody designed that surface, and for
as long as this invariant asked only `CHROME_SURFACES` the leaderboard rail
drew all twenty-four tokens on `#09090B` with no outline, no declared outline
to be missing, and a green suite. `#000000` was a black square on a black
ground in any war that had one.

> *Test:* every surface in `CHIP_SURFACES` checked against its declared
> outline; plus a dedicated case for `#FFFFFF` and `#000000`, the two tokens
> that would otherwise disappear on light and dark chrome respectively; plus an
> assertion that every surface has a declared outline, so a new surface cannot
> be added silently. That last one is what failed first when the board faces
> were brought in — three surfaces with no outline named — which is how the
> widening was known to reach anything at all.

**Partially enforced, in the same way and for the same reason as I5 and I6.**
The test measures the *colours*: that every surface a chip is drawn on has a
declared outline, and that each outline clears 60 from its surface. It cannot
see whether a component actually *applies* the outline it is owed. A chip
drawn on `shell` with no `outline` at all passes the whole suite, because a
style attribute in a component is not attached to a surface by anything a unit
test can reach. **That the outline is applied is a rule reviewers enforce**,
and it is not a hypothetical: it is exactly how the leaderboard rail came to
draw all twenty-four tokens with no outline for a whole batch. Binding the two
together — a chip component that takes its surface as a prop and cannot be
rendered without one — is the way to close it, and it is not closed today.

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

### I6 — Every chrome colour is legible under the text it carries

Distance from the palette and contrast with your own label are unrelated
tests, and a colour must pass both.

> *Test:* `contrastRatio(ACCENT, header)` >= `AA_NORMAL_TEXT` (4.5), plus a
> control asserting the guard fires on the accent that failed, plus the
> readout and body floors from §9 for `INK`, plus `MUTED_INK` measured against
> every surface in `MUTED_INK_SURFACES`, plus two controls: that the readout
> and the surround are absent from that list and would indeed fail it, and
> that ink composited at 80% — the way the first checkout expressed quiet
> text — falls under the floor it claimed to meet. `MUTED_INK_INVERSE` is
> measured the same way against every surface in `BOARD_SURFACES`, with the
> whole dark scale asserted in order and a control proving `MUTED_INK` could
> not have been used there instead — so the second quiet ink has to justify
> its own existence — plus the six composited board sites it replaced. `DISABLED_INK` is measured
> the same way, against `DISABLED_TEXT_CONTRAST` and against `MUTED_INK`, so
> the quiet end of the scale keeps its order; `DISABLED_FACE` against
> `AA_NORMAL_TEXT` and against `ACCENT`, so a dead key is legible and never
> louder than a live one; plus controls on the composited values both named
> colours replaced — 50% ink for the disabled label, and the accent through
> `grayscale(0.7) brightness(0.9)` for the disabled button.

**Why this exists.** The first brass chosen for this design, `#B87A1E`, cleared
the token palette by 90 and then failed WCAG AA on the primary button at
**4.31:1** — the accent was unmistakable from every token, and its own label
was hard to read. No amount of colour-distance work would have found that; it
took building the button. The replacement reads 5.19:1 and is *further* from
the palette, at 100.

The same class of defect came back one layer out, in the checkout: de-emphasis
written as `opacity` on text, which turns a measured contrast into an
unmeasured one and does it invisibly at review time. Hence `MUTED_INK` — a
named colour with a declared list of surfaces it is allowed on — and hence the
rule that no text in this application is ever quieted with opacity.

**And it came back a third time, in the six sites the rule was written a batch
too late to catch.** All six were in the board UI, and measuring them is what
found the more interesting half: they were on `zinc-950` and `zinc-800`, not
on the surround, so four of the six cleared 7:1 by accident and the batch that
recorded them had them wrong by up to 5 points in both directions. A number
nobody measured is not safe merely because it turns out to be fine — which is
what `BOARD_SURFACES` is: the three dark faces written down, so the text drawn
on them can be measured at all.

**Partially enforced, in the same way and for the same reason as I5.** The
tests measure the *colours*: `MUTED_INK` against every surface in
`MUTED_INK_SURFACES`, and controls proving the readout and the surround would
fail if anyone added them. They cannot see where a class is *used* — a
`.muted` dropped inside a `.readout` renders 5.70:1 against a floor of 8 with
the whole suite green, because a CSS class is not attached to a surface by
anything a unit test can reach. **The surface list is a rule reviewers
enforce.** Binding the two together — a component that takes its surface as a
prop, or a lint rule over the markup — is the way to close it, and it is not
closed today.

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
- **Neither `opacity` nor `filter` may alter the colour of text, or of a
  control that carries text.** Disabled, muted and hover states use named
  colours from [chrome.ts](src/lib/wars/chrome.ts), measured. The point is not
  that either mechanism is bad — it is that a rendered colour nobody measured
  is not a design decision, and both hide the number equally well. The rule
  was first written as "never opacity on text" and had to be widened the day a
  `filter` on the primary button turned 5.19:1 into 4.33:1 with nothing
  anywhere recording it.
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

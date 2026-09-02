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

---

## 1a. What the product sells

**Painting pixelwar requires a paid registration: one wallet, one small SOL
transfer, once, for every war there will ever be. What a community buys with
its admission is still demand — the registration is what makes a painter a
person rather than a cleared cookie.**

**This section was rewritten on 2026-08-26 by the owner's decision, and it
supersedes the version before it.** That version said "Pixelwar does not
charge the painter", refused a per-person checkout outright, and was the
conclusion of an adversarial round. The round is not disowned here: its
argument is recorded below, because the reason a norm was overturned is worth
as much as the norm.

**What the round argued, and it still stands as far as it goes.** On Solana
the credential of loyalty already exists and this product does not issue it:
it is holding the bag. A per-person fee is not sacrifice for the tribe, it is
a cover charge for the venue, and it competes with what the tribe is asking of
the same wallet. No community leader running a raid wants their soldiers
spending on the arena instead of on the ticker.

**Why the owner decided otherwise.** Three things, two of which the round had
weighed and one it had not:

1. **A small SOL fee to the creator is an established Solana pattern.** It is
   read as ritual, not as a toll — the gesture is familiar to everybody this
   product is for, and the round scored it against a general audience's
   instincts rather than against this one's.
2. **The audience being judged already holds a funded wallet.** A cover charge
   is a barrier to somebody who has to go and get money. It is not one to
   somebody who is holding the ticker being fought over.
3. **The fee is real anti-sybil, and nothing else here was.** Without it,
   thirty painters is thirty cleared cookies. With it, thirty painters is
   thirty funded wallets. That is the function the round did not price, and it
   is why the fee is a mechanic and not just revenue.

**What the fee buys, and what it does not.** It buys the identity — permanent,
per wallet, across every war. It does not buy status, a colour, a place on the
board, or anything a leaderboard can see. The two castes are unchanged, and
the rung between them is still bought from the community rather than from us.

| Caste | How you get it | What it costs |
| --- | --- | --- |
| Registered | Pay once, ever. Then paint. The first pixel commits you to one token for that war. | The registration fee, once |
| Sworn | Connect a wallet, prove you hold the token. | Nothing — the token you already own |

**The price is denominated in SOL and set by configuration, and zero is a
valid value.** `REGISTRATION_FEE_SOL=0` turns registration into a wallet
signature with no payment, in a variable, without a deploy. It exists because
a launch that shows the fee is killing the volume has to be able to stop
charging in a minute. The path is the same one either way: with the fee off
the code still requires a wallet, so a deployment that switches it off is not
running an untested variant of the paint path. See CLAUDE.md, "Decisions with
a door".

**Never call it a network fee.** Not in copy, not in a tooltip, not in an
error. Solana's own fee on this transfer is under a thousandth of a cent and
this one is ours. "Registration", "one-time registration", or the number
itself — those are the words.

**The board is not behind the fee.** `/` renders the war to everybody who
loads it, and the registration panel opens on a REFUSED PAINT, never before.
A pixel is the moment somebody decided to take part, and it is the only
honest moment to ask. A wall in front of a war nobody has seen yet is the
landing page `/` deliberately does not have.

**Loyalty is still enforced socially, not cryptographically.** A recruit's
commitment lives in a cookie and is trivially discarded, and that is accepted
rather than fought: the cost of switching sides is abandoning your own record
and starting at zero. What the registration changes is the price of a NEW
identity, not the strength of an old one's lock.

**Copy consequence, and it is absolute.** Nothing in this application promises
"free forever", promises "no wallet ever", or calls an allegiance "permanent"
or "irrevocable" — the recruit's lock is soft and copy saying otherwise would
be a lie the product tells about itself. The registration itself IS permanent
per wallet and copy may say so, because a row in `registrations` never
expires. The allowed form for allegiance is the one true either way: *you
fight for one token this war.*

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

## 5a. Between wars: a result, not an invitation

**A board nobody can paint on reads as broken unless the screen says plainly
that it is a result. Every element of the intermission serves that sentence.**

`/` is the board in all three states and there is never a landing in front of
it. The recruitment channel these communities use is a raid link, and a page
between that link and the first pixel charges a click to everyone in order to
serve the few who came to read.

| State | What it shows |
| --- | --- |
| Live | The war. |
| Between | The countdown to the next war DOMINATES; the finished board sits behind it as context, under a heading that names it a result and names the winner. |
| None scheduled | The same screen without the countdown. |
| Nothing ever finished | The same screen with a sentence where the board would be. |

**The countdown outranks the result when both are present.** The result is
context; the countdown is imminent and actionable. *"This happened, and the
next one starts in 02:14:33"* is a better screen than either half alone.

**The wordmark appears in every state, including the empty one.** Its absence
was the defect this section exists to prevent: a deployment between wars
showed a stranger three sentences on a bare background with no way to learn
what the site is — and that was the launch-day first impression.

**The finished board is `Board` with its callbacks made no-ops**, not a second
renderer. The zoom, pan, pinch and device-pixel grid all live there already
and a copy would drift. The server refuses paints on an ended war regardless;
this only stops the click being offered.

### There is no replay, and it may never be built from `pixel_events`

**Decided 2026-09-01. A replay, timelapse or scrubber of a war is not built,
and if one is ever built it may NOT be generated from raw `pixel_events`.**

**The reason is moderation, and it is a fact about today's code rather than a
risk.** `revertRegion` in [moderation.ts](src/lib/moderation.ts) does not
delete history. It `DELETE`s from `pixels` — the current board — and then
*appends* clearing events with `colour_slot = 0` and `war_token_id = NULL`.
The original events are still there, in order, with their timestamps. Nothing
anywhere in `src/` ever deletes from `pixel_events`.

So a replay rendered from that log **redraws every pixel a moderator removed,
in sequence, on a public page, and then shows it being wiped.** The board is
clean; the log is not. The worked example this project already uses for what
gets removed is in `abuse.ts` — *"whether that picture is a logo or a swastika
is a question only eyes answer"*. That is the thing that would play back.

**This overrules the spec, which is stale on exactly this point.** Section 17
of [the spec](docs/superpowers/specs/2026-08-24-pixelwar-design.md) listed
"timelapse and replay, which `pixel_events` already supports" as deferred
work. That was true on 2026-08-24 and `revertRegion` is later. It is corrected
there rather than left to be found by whoever builds this.

**The only honest way out that anybody has found is recorded, NOT adopted.**
A war with no moderation clears at all has a log that matches its board, and
`count(*) FILTER (WHERE colour_slot = 0)` distinguishes them in one line. That
is written down so the next person does not have to rediscover it — it is
**not** a rule, it is not a promise, and nothing is gated on it today. The
alternatives were both rejected: skipping every event in a moderated rectangle
also erases innocent paint and makes the replay lie about what happened, and
replaying everything publishes what was removed.

**What a test can hold, and what it cannot.** `no-replay.test.ts` asserts this
paragraph still exists, that the spec's line stays corrected, and that no
replay route or player component has appeared. It cannot judge whether some
future thing is "a replay". **That is a rule reviewers enforce**, like I2 and
like the announcement rule in §8.

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

**This used to ask a wider list than the other invariants did.** `CHIP_SURFACES`
was `CHROME_SURFACES` plus `BOARD_SURFACES` — three dark faces the board
screen had picked before this document existed, rightly exempt from §4's
chroma ceiling and I1's distance rule because the design had not chosen them,
and rightly included here because chip visibility is a different question.
That gap is closed: the board screen was restyled onto chrome surfaces, the
extra list is gone, and every surface a chip lands on is now one the design
chose and the other invariants police. The reasoning is kept because it is
what the rule is for. A token that vanishes into the surface
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
> measured the same way against every surface in `MUTED_INK_INVERSE_SURFACES`,
> with the whole dark scale asserted in order, a control proving `MUTED_INK`
> could not have been used there instead — so the second quiet ink has to
> justify its own existence — and a case pinning the board ground's **6.54:1**
> as the reason it is absent from that list. `DISABLED_INK` is measured
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

> **Settled: the accent is `#B1923B`, and `#B87A1E` does not come back.**
>
> This is recorded as closed rather than merely explained, because it has
> already been reopened once. A later brief specified the Cabinet direction as
> "latón `#B87A1E`" — quoting the superseded value in good faith, from notes
> written before the button existed to fail on. The batch that received it
> built with `#B1923B` and said why.
>
> The rule that decides it is the one this whole section exists to serve:
> **every rendered colour is measured, and a measurement beats a citation.**
> `#B87A1E` is not a matter of taste that a brief may set — it is a value with
> a number attached, and the number is below the floor. A future brief naming
> it is quoting history, not making a decision, and the answer is this
> paragraph rather than a fresh argument.
>
> If the accent is ever genuinely re-chosen, it is re-chosen the way this one
> was: swept against the palette for distance, measured against its own label
> for contrast, and only then written down.

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
nobody measured is not safe merely because it turns out to be fine.

Those faces were written down as `BOARD_SURFACES` so the text on them could be
measured at all, and they are gone now — the board screen was restyled onto
chrome surfaces, which is the condition that constant said would retire it.
What replaced it is `MUTED_INK_INVERSE_SURFACES`: the dark faces that may
carry quiet text, which is `header` and deliberately **not** the board ground,
where the muted ink reads 6.54:1 against a floor of 7. The restyle's own first
draft put the canvas loading line there, and the invariant is what caught it —
the fourth time this class of defect has come back, and the first time it was
caught by a test instead of by a person.

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

`ACCENT` marks **an action the visitor can take**, and the wordmark. Never a
chip, a bar, a border, or any element that represents a token.

Stated as a principle rather than as a list of three, because the list was
read as a cap and it is not one: the board screen carries brass on Paint AND
on "Add your token", which are two actions for two different people — one
paints, the other enters a community — and they sit in different zones of the
screen for that reason. What the invariant forbids has not moved an inch: no
token ever wears the accent, because no token ever appears as a filled
control.

The risk the list was guarding against is real and worth naming: if everything
is brass, nothing is. The check is not "how many" but "is this an action" —
a brass element that does not do something has broken the rule however few
there are.

> **Two accents, for two different people, in two different zones. A proposal
> that adds a third is debated against this principle before it is built — if
> everything is brass, nothing is.**
>
> Written as a clause rather than left as a reservation in a batch report,
> because a reservation in a report is remembered wrongly or not at all, and
> the next round is supposed to cite this file rather than somebody's memory
> of it. The count is not the rule; it is the tripwire. A third accent may
> well be right — it just does not get added without the argument.

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

### A war older than thirty days cannot be revived, and the copy says what is gone

The operator sentence, verbatim:

> This war ended more than 30 days ago and can no longer be revived. Its board
> and its result are kept; the pixel history has been cleared.

**Two sentences because a refusal owes an operator two things**: what it cannot
do, and what that cost. Saying only the first invites the reasonable next
question — *"so is the war gone?"* — and the answer is no: `pixels` and
`token_pixel_counts` survive the prune, so the board and the winner are still
there and still rendered. Only the replayable history goes.

**It names the number rather than saying "too old".** Thirty days is an
operator-facing policy in [docs/operations.md](docs/operations.md), not a
constant nobody can find, and a message that withholds it sends somebody
reading source to learn when they should have acted.

**It does not apologise and does not offer a workaround**, because there is
none: the events are deleted, not archived. Copy that hedged here would imply
somebody could be asked to restore them.

### A refusal the screen never announced is a defect, not a message

**A rule that can refuse a painter must be visible on the screen before it
refuses anybody.** The last window is the case this was written for: turning
`PAINT_SIDES_LOCK_MINUTES` above zero requires the countdown **"Sides lock in
mm:ss"** in [WarClock.tsx](src/components/WarClock.tsx), shipped in the same
batch. Never a 409 without an announcement.

This is a rule about ORDER, and the order is the whole point. The mechanism
and the announcement are separable — the mechanism shipped first, switched
off, deliberately — and a batch that turns the setting on without building the
countdown is not "most of the feature". It is the only version of the feature
that is worse than nothing: a painter meets a refusal nobody warned them
about, in a game where the refusal is invisible until it fires.

**mm:ss and not hh:mm:ss**, because it is only shown once the window is close
enough to be worth acting on. A countdown to something four hours away is
chrome; §5's clock already carries the war's own deadline.

**Why a countdown rather than a sentence.** "Sides close an hour before the
end" is a promise about how wars work, and the setting is per-deployment, so
it is a promise the product cannot keep on its own. A countdown states a fact
about the war in front of you and claims nothing about the next one — the
same distinction the rest of this section draws between what is true now and
what is permanent.

**This one cannot be fully enforced by a test**, in the same way and for the
same reason as I2: a test can assert this paragraph still exists, and
`copy-announcement.test.ts` does. It cannot see the value of an environment
variable in a deployment. **That the countdown ships with the switch is a rule
reviewers enforce**, and the operator-facing half of it is in
[docs/operations.md](docs/operations.md).

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

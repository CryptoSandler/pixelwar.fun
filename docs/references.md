# Reference reading: rplace.live, wplace.live, and one open-source client

Read before designing the canvas, the cooldown, and the moderation rules. This
file records what the two largest live r/place descendants actually do, so our
own choices are made against something real rather than against a memory of the
2022 Reddit event.

Nothing here is copied into the product. Their copy is quoted so we can see how
they phrase things and then write our own; their code is described so we can
learn the shape and then write our own. See [Licensing](#licensing-why-we-read-
rather-than-fork) for why that boundary is not optional.

## How this was gathered

Firecrawl was requested and is not available in this repo: it is configured as
an OAuth MCP server under the `outbid-tokens` project scope only, and the
session that did this research was non-interactive, so the OAuth flow could not
run. Substitutes used instead:

| Source | Method | Confidence |
| --- | --- | --- |
| wplace.live home, paint gate | Playwright (Chromium, desktop 1440×900 and iPhone 390×844) | Observed directly |
| wplace.live community guidelines, terms | HTTP fetch of `/terms/community-guidelines` | Verbatim from source |
| wplace.live charge/palette numbers | Third-party FAQ (wplacepaint.com) | **Unverified** — painting is behind a login we did not create |
| rplace.live UI and copy | Full client source, `rplacelive/game` @ 2026-08-23 | Verbatim from source |
| rplace.live live UI | Playwright failed (page renders blank headless, WebGL2 present but body empty); the project's own `site_demo.png` was read instead | Observed, but from an older build |

Screenshots were captured to a scratchpad directory and deliberately **not**
committed: they are full of other people's artwork and neither the pixels nor
the site chrome are ours to redistribute.

## rplace.live

A faithful recreation of the 2022 Reddit event, 2000×2000, running permanently.
Canvas dimensions and the cooldown are served per instance, not hardcoded in
the client:

```
GET / -> { canvas: { width, height, cooldown } }
```

**Cooldown and timer.** The countdown is rendered *inside the place button
itself* — the button is the timer. A clock icon followed by `HH:MM:SS` while
more than a second remains, then the raw milliseconds in orange for the last
second, then the button flips back to its "Place" label. The redraw interval
adapts to what is being shown: 500 ms while counting seconds, 100 ms in the
final second. On placing, the client **predicts** its own new cooldown
immediately rather than waiting for the server to confirm, and the source notes
this makes the client's timer slightly short of the real one. `cooldownstart`
and `cooldownend` fire as window events, each with a sound.

**Palette.** A drawer that slides up, one element per colour, generated from a
palette array. Every swatch carries a rebindable **keyboard shortcut** — the
defaults are `123456789abcdefghijklmnopqrstuvwxyz`, so the first nine colours
are the number row. Colours are stored as packed 32-bit integers and the
palette is uploaded to the GPU as its own texture. Pure white gets an explicit
outline so it stays visible against the drawer.

**Zoom and pan.** Hand-written pointer handling, no library. Two touch points
are tracked; pinch scale is the ratio of current to initial distance between
them. The detail worth stealing is `touchMoveDistance`: it starts at 15 and is
decremented by the absolute movement of every touchmove, and a touchend only
counts as a *placement* if it is still above zero. That is how a drag across
the canvas does not paint a pixel where your finger lifted.

**What a pixel shows.** There is a "Show pixel placer info" toggle, and a
"Pixel placer info" panel with `Position`, `Name`, `User ID`, and a `Report
pixel` action ("Report the player who placed the pixel at …", free-text
`Reason`, 280-byte cap). Hovering shows "Placed by:". So: identity of the
placer is first-class, and reporting is aimed at the person.

**Stats.** `GET /users/{intId}` returns `pixelsPlaced`, `playTimeSeconds`,
`lastJoined`, `online`. There is no canvas-wide leaderboard: there is no team
to rank, only individuals.

**Anti-bot and identity.** Three separate gates in one client: a passkey
requirement ("Passkey required — Use a passkey to place pixels and send chat
messages"), an hCaptcha dialog, and a homegrown emoji captcha ("Solve this
small captcha to help keep rplace.live fun for all… Please click the button
containing the emoji you see below"). A Cloudflare Turnstile manager also ships
in the client's services.

**Moderation.** Staff actions are in-client: `Delete message`, `Kick`, `Mute`,
`Ban`, `Captcha`, with "Apply to all players", plus a punishment-review queue
for appeals. The notice to staff is worth reading twice:

> All moderation actions are logged by the server and reports sent to all other
> staff. Follow the moderation rules. Do not abuse power.

**Onboarding copy**, shown over the canvas:

> There is an empty canvas.
> You may place a tile upon it, but you must wait to place another.
> Individually you can create something.
> Together you can create something more.

**Locked-canvas copy**, for archived boards:

> This canvas is locked... You can't place pixels here anymore

**Other features observed:** a template overlay system (`Image X`, `Image Y`,
`Image Opacity`, `Nearest match`, `Ignore invalid colours`, `Sharpen image
edges`, `Copy overlay URL`) that lets a community trace a design onto the
canvas; render-layer toggles (`Canvas layer`, `Changes layer`, `Pixels layer`);
spectating a user; live chat; a timelapse panel; and a set of archived past
canvases (`r/place 2022 (Classic)`, `snowplace.live`, `goldplace.live`, …).

## wplace.live

The same idea projected onto a world map. Painting is gated:

> Log in to place pixels on the shared world map.
> **Continue with Google**
> By continuing, you agree to our Terms of Service, Privacy Policy and
> Community Guidelines.

**Chrome.** Almost none. The canvas is full-bleed; a single primary **Paint**
button sits centred at the bottom; zoom `+`/`−` and an info `i` stack in the
top-left with the current colour swatch under them; `Log in`, a leaderboard
icon and a locate icon sit top-right; a layers toggle bottom-left and help
bottom-right. Nothing else competes with the artwork. This is the layout to
beat.

**Charges instead of a cooldown.** Rather than one timer, wplace accrues
"charges" that stack, so a player who has been away can place a burst. Third-
party documentation puts the recharge at "typically 30 seconds to a few
minutes" and the palette at 64 colours split into free and premium, the latter
paid for with a currency called Droplets; the store also sells flags, borders,
badges and name styles. **These numbers are unverified** — we could not reach
the painting UI without creating an account.

**Leaderboard.** Filterable by `Regions`, `Countries`, `Players`, `Alliances`.
Alliances are a real construct: 25,000 Droplets to create, with `Invite only`,
`By request` and `Open` join policies. Events are scored ("1 point per pixel +
1 extra per 30 minutes alive") — note that scoring rewards pixels *surviving*,
not merely being placed.

**Community guidelines**, verbatim, with their stated penalties:

| Rule | Text | Penalty |
| --- | --- | --- |
| Inappropriate content | "Explicit, hateful, or illegal content is not tolerated." Covers explicit sexual material, sexualization of minors, extreme gore, hate speech, doxxing, targeted harassment. | Permanent ban |
| Griefing | "Destroying others' work with no creative intent." | Timeout |
| Multi-accounts & bots | "One account per person. No automation or exploits." | Permanent ban |
| Territorial disputes | Competing for map space is core gameplay. | Allowed |
| Map cleanup | Removing spam and inappropriate content with transparent pixels. | Allowed |

Suggestive-but-not-explicit content is not punished but may be painted over by
anyone. The team describes its posture as "hands-off", intervening only when a
rule is clearly broken.

## Open-source client: `rplacelive/game`

Chosen because it is the actual client behind rplace.live, is still being
pushed to (last commit 2026-08-23), and ships a written `PROTOCOL.md` — most
"r/place clone" repos on GitHub are 2022-era drawing bots or one-weekend toys.

**State format.** The board is one byte per pixel, palette index, no header, no
coordinates:

```
position = y * width + x
x = index % width
y = floor(index / width)
```

The full board is fetched as a raw binary blob from static hosting. Live pixels
arrive as a 6-byte WebSocket packet: `u8 code | u32 position | u8 colour`. The
comment in their protocol doc — "We could've sent coordinates but nah, maths is
fun!" — undersells it; a flat index is half the bytes of a coordinate pair.

**Three layers, not one.** The client holds three same-sized `Uint8Array`s:

- `BOARD` — the base snapshot, fetched once.
- `CHANGES` — recent changes, filled with the sentinel `255` for "nothing here".
- `SOCKET_PIXELS` — pixels arriving live, same sentinel.

Each is its own GPU texture and the fragment shader composites them, live over
changes over base. The point is that a single pixel change never re-uploads the
base board. Colour is masked with `& 63`, so the top two bits of a cell are free
for flags and the palette is capped at 64.

**Rendering.** WebGL2. The board is an integer texture (`RGBA8UI`), the palette
is a second texture, and the fragment shader looks up the palette by index —
meaning a palette change recolours the entire canvas without touching board
data. Hit-testing is done by rendering pixel ids into a separate pick
framebuffer and reading a texel back, which is the right answer for their 3D
and mesh renderers and overkill for a flat axis-aligned board.

### Licensing: why we read rather than fork

The project is **LGPL-3.0**, and its README adds an explicit request:

> out of goodwill we request forks are not run commercially (That is, they
> should not generate more than the cost of server upkeep).

pixelwar.fun charges for entry. So this repo takes no code, no assets, no
sounds, no copy, and no palette values from it. What we take is knowledge:
flat-index state, base-plus-overlay layering, palette-as-indirection, and the
tap-versus-drag threshold. Those are ideas, and ideas are not the licensed
thing. Anyone reviewing this repo should be able to diff it against theirs and
find nothing in common but the concepts.

## What we adopt, and what we don't

### Adopt

| From | What | Why |
| --- | --- | --- |
| rplace | Flat index state, one byte per pixel | 200×200 is 40 KB raw and compresses to almost nothing; it is the format both our snapshot and our diff want |
| rplace | Base canvas + diff overlay | Exactly the split between `/api/canvas` and `/api/diff` we already planned; validates it |
| rplace | Palette as indirection | Our palette *is* the token attribution, so an index-to-token map is the whole data model |
| rplace | Countdown rendered in the paint button | One control, no second widget; the button being unavailable and the reason it is unavailable are the same object |
| rplace | Client-side cooldown prediction | The canvas must feel instant even though the server is authoritative |
| rplace | Adaptive timer resolution | 500 ms above a second, 100 ms below; avoids a per-frame timer for a countdown nobody is staring at |
| rplace | Tap-versus-drag movement threshold | Without it, every pan on mobile ends in an accidental pixel |
| rplace | Keyboard shortcuts on the palette | 24 tokens, so `1`–`9` plus letters covers the whole board |
| rplace | Coordinate + zoom readout | `(1001,1000) 0.02x` top-centre; cheap, and it is how people tell each other where to paint |
| rplace | "This canvas is locked" as a first-class state | An ended war needs exactly this: a frozen board that still reads |
| rplace | Template overlay | See the scope note below |
| wplace | Full-bleed canvas, one primary action | The artwork is the product; chrome is a tax |
| wplace | Explicit rule table with stated penalties | Better than prose: a reader can find their case |
| wplace | Scoring survival, not placement | Our leaderboard already ranks pixels *currently owned*, which is the same instinct |
| wplace | Naming griefing as allowed-by-default | Territorial conflict *is* the game; only targeted harassment is not |

### Don't adopt

| From | What | Why not |
| --- | --- | --- |
| both | Accounts as the identity gate | No accounts is a product decision, not an oversight. wplace requires Google, rplace requires a passkey — see the risk note below |
| rplace | Live chat | A moderation surface with staff cost, and the token communities already have Telegram and X |
| rplace | Per-pixel placer identity ("Placed by", user id) | We have no accounts and our painter key is a salted hash. Surfacing it would be a deanonymisation vector for zero gain: here the interesting author is the *token*, not the person |
| rplace | Reporting a *player* | Nobody to report. Our report is about a region of canvas |
| rplace | WebGL renderer, pick framebuffer, 3D and mesh renderers | 40,000 pixels is four orders of magnitude below where Canvas2D struggles. Inverse-transforming a click is three lines |
| rplace | Spectating, quests, badges, premium page, sounds | Retention machinery for a permanent canvas. A 48–72h war does not have a retention problem |
| wplace | Charges that stack | Stacking lets one organised group bank a burst and flip a region at the deadline. A flat per-war cooldown is more legible and harder to game. **Re-confirmed 2026-09-01, and the reason grew teeth:** "bank a burst and flip a region at the deadline" is the exact threat the last window (batch 4) was built against, and `docs/operations.md` measures why it cannot be absorbed — one row lock on `wars` per paint, held for five round trips, so a banked burst does not degrade, it queues, and the war stalls for everybody. A charge pool is the one mechanic that multiplies the peak this system is least able to take. See "The charge pool was considered and rejected" below |
| wplace | Paid colours, Droplets, cosmetics store | Our colour is not for sale by the pixel — it is the token's identity, bought once at entry. Selling colour twice would muddle the product |
| wplace | Alliances | The token is the team. A second grouping layer on top of 24 tokens is noise |
| both | Permanent canvas | Wars end. That is the product |

### Risk note we are choosing to accept

The two largest live implementations both gate painting behind an identity: a
Google account (wplace) or a passkey (rplace), *and* both additionally run a
captcha. We are shipping with neither, on a cookie-plus-IP cooldown. That is a
weaker gate than anything in production elsewhere, and it is a deliberate
trade: an entry-fee product cannot afford a signup wall in front of the free
half. The mitigations that make it survivable are already in the spec — the
Turnstile hook, the subnet burst cap, admin bans by painter key — and the
upgrade path, if a war is visibly botted, is rplace's answer rather than
wplace's: **a passkey is free, needs no email, and is device-bound**. Recorded
as the first thing to reach for, not built now.

## Changes this research makes to the spec

1. **`/api/canvas` returns binary, not a string.** The original brief said a
   string of palette indices. One byte per pixel over
   `application/octet-stream` is 40,000 bytes, gzips to a few KB on a sparse
   canvas, needs no charset decisions, and lands in the client as the
   `Uint8Array` the renderer wants anyway. The diff stays JSON.
2. **The client keeps two arrays, not one** — the fetched base and an overlay
   of everything `/api/diff` has returned since, with a sentinel for "no
   change". Redraws composite the two.
3. **Pixel inspection is specified, and specified to exclude the painter.**
   Clicking a pixel shows position, the owning token, and when it was painted.
   Never who.
4. **Tap-versus-drag threshold, coordinate/zoom readout, and palette keyboard
   shortcuts** are now client requirements rather than polish.
5. **Template overlay added to v1** *(scope addition — cuttable)*. Both
   references ship one, and for a token community it is the difference between
   wanting their logo on the canvas and being able to put it there. Entirely
   client-side: pick a local image, position it on the grid, opacity slider,
   nothing uploaded, nothing stored.
6. **Content reports added to v1** *(scope addition — cuttable)*. A report
   names a rectangle, not a person, and lands in a table the admin console
   lists. Without it the only moderation signal is somebody finding us on X.
7. **Rules page restructured as a table of rule → penalty**, following wplace,
   with our own text.
8. **Ended wars get an explicit frozen state** with its own copy, rather than
   a paint endpoint that simply starts refusing.

---

## Provenance of the mechanics round, 2026-09-01

**Why this section exists.** Everything above was read before the canvas was
built, and it is research. This is a different claim: it names, for each
mechanic shipped in this round, whether it came from a reference, from this
repository, or from nowhere but us. Six months from now "we took the last
window from r/place" should be a recorded fact rather than a rumour, and — the
half that matters more — the mechanics with **no upstream** should be
identifiable, because those are the ones no amount of reading can check.

**Nothing was copied.** No assets, no code, no copy, no palette, no colour
value. The boundary is the one stated at the top of this file and in
[Licensing](#licensing-why-we-read-rather-than-fork): a mechanic can be
learned from; an implementation cannot be taken.

| Mechanic | Where it came from | Confidence in the source |
| --- | --- | --- |
| Empty-board roster, momentum signal | Ours. Neither reference has an ownership layer, so neither can have either. | n/a |
| Deep links to a place on the board | Genre-standard; both references carry canvas coordinates in the URL. Ours is built on `openingViewport`/`clampToBoard`, which already existed. | Observed |
| Template overlay, client-only | **This file, item 5 of "Changes this research makes to the spec"** — specified before this round began, and client-only there too. | Our own spec |
| Endgame rule in the last window | r/place's final act (the 2022 "whiteout"). The mechanic taken is *"the last window plays by a different rule"*, not that particular rule. | Widely reported; not observed by us |
| In-page replay from history | r/place's timelapse, which is a post-hoc video. Ours is served from `pixel_events` and is the same data the diff protocol already carries. | Widely reported |
| Result card per token | Ours. It depends on `token_pixel_counts`, which depends on attribution being separate from colour. | n/a |

### The charge pool was considered and rejected

**Decided 2026-09-01. The flat per-war cooldown stays. There is no charge
pool, and stacking charges are not a mechanic this product has.** The entry
lives here rather than only in "Don't adopt" because for one batch this file
said BOTH things at once, and the shape of that mistake is worth keeping.

**The contradiction.** "Don't adopt" has rejected stacking charges since this
file was written, on the grounds that they let a group "bank a burst and flip
a region at the deadline". The attribution table below listed a charge pool as
a mechanic of this round, with N and T still to be chosen. Two tables, one
document, opposite answers — and the second one was added later by somebody
reading the research and not the rejection.

**Why the rejection wins, and it is not seniority.** The stated reason turned
out to be the same threat batch 4 spent a whole batch on. `docs/operations.md`
measures what a deadline burst costs: every paint takes a row lock on `wars`
and holds it for five more round trips, so throughput is `1 / (5 x round-trip
time)` and a burst does not degrade — it queues, and the war stalls for
everybody at the one moment anybody is watching. Batch 4's whole design
criterion was that the last window must not accelerate writing. A charge pool
is the mechanic that multiplies exactly that peak. Shipping both would have
been building a brake and an accelerator in consecutive batches.

**The lesson that outlives the decision, and it is why this section kept its
place rather than being deleted.** The old heading here was "The one number
nobody should quote from here", and it was about N and T: wplace's charge
figures come from a fan FAQ because painting is behind a login we did not
create, so quoting them would have been laundering a rumour into a spec. That
warning was correct and is now moot, which is the tell. **A norm written to
protect a number that no longer exists is a norm about a mechanic nobody
decided to build.** The general form: when this file explains how to choose a
value carefully, check first that anything chose to need the value.

`charge-pool-rejected.test.ts` asserts this stays decided.

### What is ours, and has no upstream to check against

- **Attribution separate from colour.** A pixel's owner is a token; the colour
  on it is the painter's free choice. Neither reference has an ownership layer
  at all, which is why the territory layer, the momentum signal and the result
  card have no prior art to be measured against.
- **Tokens as factions**, with logos, tickers and a paid admission.
- **Sworn wallets**: a caste proved by holding the token being fought for.
- **The intermission**: a finished war with a winner, standing between wars.

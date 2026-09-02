# Operating rules

Decisions that live in configuration rather than in the schema, and are
therefore only true while somebody keeps them true.

## Token admission cap: keep wars at 24 or fewer

**A war's admission cap may be set as high as 255. Set it to 24 or lower
anyway, until the palette has more than 24 colours.**

The schema stops at 255 because that is arithmetic and nothing else: the
territory layer names a pixel's owning token in one byte and reserves 0 for
unpainted (see `canvas/state.ts` and migration 008). There is no number
between 24 and 255 that the database has an opinion about.

What breaks past 24 is not the data, it is the reading of it. `PALETTE` has
24 entries, so `flagColourForSlot` wraps: token 25 flies the same flag as
token 1. On the scoreboard and in the territory view those two communities
become one colour, told apart only by ticker — and the territory view exists
precisely to answer "who owns this" at a glance, which it can no longer do
for either of them.

**This is deliberately a rule and not a constraint.** A `CHECK` at 24 would
be the same mistake the old schema made — a limit imposed by the size of a
colour list, frozen into the database, where changing it costs a migration
and where nobody reading it can tell whether 24 is a product decision or an
accident. It was an accident for the whole life of the project until
migration 008 removed it. Putting it back would re-earn that confusion.

So the ceiling is honest arithmetic, the guidance is operational, and the
admin screen says the consequence out loud next to the input where somebody
is about to type a number.

**When this rule expires:** the day `PALETTE` grows past 24 entries. Then the
cap can rise to the new palette size with nothing else to change, because
`flagColourForSlot` already wraps at `PALETTE_SIZE` rather than at a literal.

## Closing the sides: `PAINT_SIDES_LOCK_MINUTES`, and it ships OFF

**The mechanism exists; the policy is the owner's and has not been decided.
The default is `0`, which means no lock, and that is a decision rather than a
placeholder.**

| Setting | Default | What it means |
| --- | --- | --- |
| `PAINT_SIDES_LOCK_MINUTES` | `0` | Minutes before `ends_at` in which nobody NEW may pick a side. `0` disables the rule entirely. |

**What it does.** Inside the window, a painter who has never painted in this
war is refused with `sides_locked` (HTTP 409). A painter who already has an
allegiance is untouched and paints normally. Nothing else changes: not the
cooldown, not scoring, not the deadline.

**Why the scarcity is over joining rather than over painting, and this is the
whole reason the setting has this shape.** A war's ending is most of why
anybody is watching, and every obvious way to make the final minutes count
for more *concentrates paint* at the moment concurrency peaks — which is
exactly what "The write ceiling, and the co-location that lifted it" below says
this system cannot absorb. A spike there does not degrade, it queues on one
row lock, and the war stalls for everybody at the only moment that matters.

This rule can only ever turn a paint into a refusal, so it cannot raise the
rate under any input, and it refuses above the `last_seq` update so it never
queues behind that lock either. `sides-lock.test.ts` asserts the sequence
does not move on a refusal — that is the property the design was chosen for,
and it is checked rather than argued.

Its second effect is the one that pays for it: the deadline pushes
recruitment EARLIER. The armies form before the window or they do not form.

**TURNING THIS ON REQUIRES THE COUNTDOWN, IN THE SAME BATCH. This is a
condition on the setting, not a suggestion.**

Raising `PAINT_SIDES_LOCK_MINUTES` above zero is only allowed together with
the **"Sides lock in mm:ss"** countdown in `components/WarClock.tsx`, shipped
in the same batch. **Never a 409 without an announcement.** DESIGN.md §8
carries the design half of this rule and a test asserts both halves are still
written down.

The question this settles was left open when the mechanism shipped: does a war
announce the lock? It does. "Sides close an hour before the end" was rejected
as the wording — it is a promise about how wars work, and the setting is
per-deployment, so it is a promise the product cannot keep on its own. A
countdown states a fact about the war in front of the painter and claims
nothing about the next one.

**What that means for an operator, concretely.** The setting is not a knob you
may turn on a live deployment today, because today there is no countdown to
turn on with it. It is a knob that becomes available the day the countdown
ships. Until then, `0` is not a placeholder — it is the only correct value,
and it is set explicitly in Production and Preview rather than left to the
code's default, so that reading the environment answers the question instead
of requiring somebody to go and read `config.ts`.

**A garbage value reads as OFF, not as some lock** — a typo must not switch on
a rule about what winning means. See `sidesLockMinutes` in `lib/config.ts`.

**When this rule expires:** it does not, but the number is a guess until the
first real war. Watch the last hour of one and see whether the ending needed
help at all — the momentum signal in the sidebar may already be doing this
job, and if it is, the honest setting stays `0`.

## No replay is served, and `pixel_events` is not a publishable artifact

**Decided 2026-09-01. Nothing serves a replay, timelapse or scrubber, and
`pixel_events` must never be handed to a client as one.** DESIGN.md §5a
carries the reasoning; this is the operator-facing half.

**What an operator needs to know in one sentence:** the current board is
moderated, and the event log is not. `revertRegion` clears `pixels` and
*appends* clearing events; it never deletes the original ones. So the log
still contains every pixel that was taken down, and anything that renders the
log renders those pixels again.

**This binds exports too, not just a UI.** Dumping `pixel_events` for a
partner, an announcement, an NFT of the board's history or a "best wars of the
season" reel is the same act as building the player. The rule is about the
data leaving, not about the component.

**A war with zero moderation clears is the only honest exception anybody has
found, and it is NOT in force.** `count(*) FILTER (WHERE colour_slot = 0)`
tells the two apart. It is written down so it does not have to be rediscovered;
adopting it would mean promising that a war with a single clear never gets a
replay, and that promise has not been made.

## `pixel_events` retention, and the revive horizon that unblocked it

**DECIDED AND IMPLEMENTED 2026-09-01.** This section was a proposal with a
blocker attached: `reviveWar` accepted any ended war forever, so "after the
war can no longer be revived" was not a condition that existed, and pruning
before it did would have deleted the history of a war somebody might still
revive — leaving the diff protocol serving a board whose log has holes. The
horizon was the decision; the prune followed from it in ten lines.

| Question | Answer |
| --- | --- |
| Horizon | **30 days after `ended_at`.** `reviveWar` refuses past it with `too_old_to_revive`; the copy is in DESIGN.md §8. |
| Owner | The reconcile sweep, `/api/cron/reconcile`, beside `pruneOathNonces` and `pruneTokenSnapshots` — for the reason its own comment gives: *"a table that only grows is a slow leak"*. It reports `eventsSwept` like the other two. |
| What is pruned | `pixel_events` for wars with `status = 'ended'` and `ended_at` past the horizon. Never a live war, and never a revived one: `reviveWar` clears `ended_at`, so the candidate query stops seeing it. |
| What survives | `pixels` — the final board — and `token_pixel_counts`. The result screen, the share image and the standings read those, so an old war still shows its board and its winner. What is lost is how it got there. |

**ONE CONSTANT, NOT TWO.** `REVIVE_HORIZON_DAYS` lives in `wars/lifecycle.ts`
and `prunePixelEvents` imports it. Two numbers that must agree are one number
with a bug waiting in it, and the failure mode is the quiet kind: prune at 30
while revive allows 45 and the gap is a fortnight of wars that come back with
no history. `revive-horizon.test.ts` asserts a war one day inside the horizon
survives a full sweep AND is still revivable, which is the property neither a
test of the horizon nor a test of the prune could catch alone.

**Changing the horizon is a one-line change here and in nothing else** — but
it is a product decision, not a tuning knob, and lengthening it after wars
have been pruned does not bring anything back.

**The price, with the arithmetic shown.** Measured on the preview branch:
1,868 rows occupy 835 KB all-in, 447 bytes per row — inflated, because page
overhead dominates a table that small. At scale the row is nearer 190 bytes
with its primary key. So:

| Events in one war | Storage |
| --- | --- |
| 100,000 | 19 – 45 MB |
| 1,000,000 | 190 – 450 MB |

**Neon's `branch_logical_size_limit` on this project is 512 MB**, and every
branch — `production`, `tests`, `preview` — carries its own copy. At the
pre-co-location ceiling of ~15 paints per second a saturated 72-hour war was about 3.9
million events, which does not fit. A realistic war is far smaller, but the
point stands: **this table is the only one in the schema that can fill the
database on its own, and nobody owns it.**

**What it costs to defer:** nothing until the first busy war, and then it is an
incident rather than a task — a full branch is a database that refuses writes,
which means it refuses paint. **What it costs to decide:** one product call on
the revive horizon, after which the prune is ten lines beside two that already
exist.

## Board size is per war, and it does NOT move the write ceiling

**A war's board is `wars.width` × `wars.height`, between 100 and 1000 a side,
default 200. Changing it changes bandwidth and nothing else that matters.**

**THE WRITE CEILING IS PER WAR, NOT PER PIXEL, AND A BIGGER BOARD DOES NOT
RAISE IT.** Every paint takes one row lock on the `wars` row and holds it for
five more round trips, so throughput is `1 / (5 × round-trip time)` — see "The
write ceiling" below. Nothing in that sentence mentions area. A 1000×1000 war
and a 200×200 war have the same ceiling, and it is the same lock. **The
temptation this exists to refuse is "the board is bigger, so it can take more
painters".** It cannot. What a bigger board buys is room for more art, not
more paint per second; a war that outgrows its ceiling needs a second war, not
a wider board, and that is the horizontal scaling the ceiling section
describes.

**WHAT DOES CHANGE IS BANDWIDTH, AND IT IS QUADRATIC IN THE SIDE.**
`/api/canvas` serves one byte per pixel, to every spectator, on every poll:

| Board | Bytes per canvas fetch | Against 200×200 |
| --- | --- | --- |
| 200×200 | 40 KB | 1× |
| 400×400 | 160 KB | 4× |
| 1000×1000 | 1 MB | **25×** |

And there is a second-order effect worth knowing before choosing 1000.
`DIFF_MAX_CHANGES` is 8000, and past it a client is told to resync — to refetch
the whole board. A bigger board takes more paint per minute, so it crosses that
threshold more often, **and each crossing costs 25× more**. The cost is worse
than the area suggests.

**Why the bound is a CHECK and the token cap is not.** The token cap comes from
the length of a colour list, which is taste, and lives here as a rule an
operator can break. These are not taste: below 100 a side there is not enough
board to draw something recognisable, and above 1000 a single response is a
megabyte per spectator per poll — a denial of service an operator performs on
themselves. A ceiling that is arithmetic about bytes belongs in the schema.
Migration 018 has it; `createWar` refuses out-of-range sides by name first, so
an operator reads a sentence rather than a Postgres constraint error.

## Ban terms: how long is a ban, by default

**The admin panel offers a fixed term (24 hours) and never writes a ban with
no expiry. Whether the product should have permanent bans at all is the
owner's open decision.**

The mechanism supports both. `bans.expires_at` is nullable and `banKey` will
write `null` when a caller asks for it, so nothing has to be rebuilt whichever
way this lands. What the panel does is choose a default, and the default is a
term.

**Why a term is the default rather than a policy choice made by omission.** A
ban with no end is an irreversible sentence, and the identity it names is a
cookie or a hashed address — neither of which reliably identifies a person for
very long. A permanent ban on a discardable key mostly punishes whoever
inherits that address next, which is somebody who did nothing. The offender
clears their cookies and comes back either way.

**What is NOT written anywhere, and must not be:** no copy in this application
tells anybody they are banned permanently, or for how long, or that a ban can
be appealed. The panel's operator sees the expiry; the banned painter is
simply refused, exactly as `isBanned` has always refused them — see
`paint.ts`, where a banned caller leaves no row behind, because a refusal that
records something tells the attacker they exist.

**If this is revisited:** the thing to look at is whether repeat offences
cluster on the same key, which is the only evidence that a longer term would
do anything. `listBans` keeps expired rows for exactly that reason — a list
that dropped them would make a second offence look like a first one.

## The sybil price: the registration first, the token second

**SUPERSEDED IN PART, 2026-08-26.** This section used to say "painting is not
charged for, and the identity that is expensive to replace is the sworn
wallet". The first half is no longer true: the owner decided painting requires
a paid registration, and DESIGN.md §1a carries the decision and the argument
it overturned. The rest of this section stands, so it is corrected rather than
deleted — what it says about MODERATION was never about the fee.

**There are now two expensive identities, and they are different wallets.** A
registration is one funded wallet per painter, paid to us. A sworn wallet is a
token purchase, paid to the community. Neither is shed by clearing a cookie,
which is the whole point of both.

`bans` accepts `wallet` since migration 011, and `isBanned` resolves BOTH: the
sworn wallet in `war_painters` and the registered wallet in `painter_wallets`,
in one subquery, before the paint transaction takes its row lock. A ban that
only bit one of them would be a ceremony — the offender re-links or re-swears
the other and carries on.

**Reach for the wallet key first when it exists**, and it now almost always
exists: a painter who has painted has registered. It is the only key that
costs money to replace.

**What a ban does NOT do is refund.** A banned wallet's registration stays in
the table and stays paid. That is deliberate and it is also the uncomfortable
part: the operator is banning somebody who paid. Two consequences worth
holding in view — bans should name a reason, and the registration fee stays
small enough that a ban is not a financial event.

## Sworn holdings: verified once, at the oath

**A wallet's holding is checked when it swears and never again. Selling
afterwards does not revoke the badge. Whether that should change is the
owner's open decision, to be taken after the first real war.**

The oath is sworn with skin in the game and it is good for the war. Two
alternatives were considered and both are worse today:

**Re-verify on every paint** puts an RPC call in the hot path of the one
action that has to stay free and fast. Painting is the volume, the volume is
what a community's admission buys (DESIGN.md §1a), and taxing it to police a
badge inverts the product.

**Re-verify on a schedule** is a different product, not a setting. It means
deciding what a lapsed oath looks like — does the badge vanish mid-war, does
the painter get told, does their allegiance survive it — and every one of
those is a question about how the game feels rather than about correctness.

**What would justify revisiting it:** evidence of the specific abuse, which
is somebody borrowing tokens to swear and returning them. That leaves a
trace — a wallet sworn to a token it no longer holds — and the trace can be
looked for with a query before any code is written for it. Nothing has been
built to detect it because nothing has happened yet.

**What is NOT written anywhere:** no copy says a badge is permanent, or that
holdings are monitored, or that an oath can be lost. The sanctioned wording
is the one the whole allegiance mechanic uses — *you fight for one token this
war.*

## The backlog alert travels on a late channel

**Parked, deliberately. Nothing is built for this now.**

The unmatched-payment alert reaches a person by failing
`.github/workflows/reconcile.yml`, which emails the repository owner. That is
the right mechanism — it needs no new service, no new secret and no
integration to keep alive — and it rides a channel that is measurably late.

GitHub's scheduler deprioritises low-activity repositories. Measured here:
two consecutive scheduled runs 2h29m apart against a five-minute schedule,
and after the interval was changed to hourly, a gap of more than four hours.
The daily Vercel cron in `vercel.json` fires the same endpoint, so there are
two paths; neither is punctual.

**What this does and does not break.** Reconciliation itself does not depend
on either — that moved to the request path in `lazy-recovery.ts` precisely
because no external scheduler could be relied on. What is affected is only
the ALERT: an unmatched payment can sit past its 24-hour threshold before the
red run that announces it actually happens.

**A SECOND PASSENGER RIDES THE SAME CHANNEL, and it is more sensitive to the
delay.** The board signal (below) reports on the same response, so **the
detection latency for "something odd is on the board" is the job's cadence,
which is hours.** That matters more than it does for payments: the scenario
the board signal was built for is the first hour after an announcement, and
an alert that arrives four hours later has missed it. This does not change
what was built — it changes what the alert can be relied on for, which is
"catch it eventually", not "catch it now". Somebody watching in the first hour
is still the only thing that catches the first hour.

**THE TRIGGER FOR REVISITING THIS, written down so nobody has to notice it
twice:**

- the first real orphaned payment that waits more than 24 hours, or
- a war with paid entries running.

Either one, and the channel gets looked at.

**Options already known, so the next round starts from here rather than from
scratch:**

1. **An external punctual cron** hitting `/api/cron/reconcile` — the endpoint
   already accepts a bearer token, so this is configuration rather than code.
2. **Accept the daily sweep's latency** and say so in the operator's
   expectations, which is honest and costs nothing.

Both are decisions about how fast a human must hear, and that number is not
knowable until real money has been through the queue once.

## The write ceiling, and the co-location that lifted it

> **The number has been ~40, then ~15, and is now higher again — twice for the
> same reason.** ~40 was a projection resting on an assumed 5 ms round trip.
> Measuring it on 2026-09-01 gave 15-16 ms and a ceiling of ~12-15/s, because
> the functions were in `iad1` and the database in `us-east-2`. Moving the
> functions to `cle1` the same day removed that hop. See "The number that
> matters in production" below for both measurements and the method. **The
> shape of the ceiling never changed; only the constant did, and it is a
> property of where the two halves are sitting rather than of the code.**

**Architectural rather than a setting.** Every paint takes
a row lock on its war — `UPDATE wars SET last_seq = last_seq + 1` — and holds
it for **five more round trips** before COMMIT. Throughput per war is
therefore `1 / (5 x round-trip time)`, and nothing about connection pools,
instance count or CPU changes it.

**It scales horizontally by war, not by hardware. N wars run at N x the
throughput.**

### The evidence

A load test against the `preview` branch, from a machine 173ms from Neon:

| painters | wall clock | throughput |
| --- | --- | --- |
| 25 | 24.4s | 1.02/s |
| 50 | 45.9s | 1.09/s |
| 100 | 58.4s | 1.07/s |

Flat throughput under rising concurrency is the signature of serialisation
rather than saturation — a pool that was merely too small would show
throughput climbing with the pool, and raising it from 10 to 50 changed
nothing.

Confirmed rather than inferred, by running two wars at once:

    15 paints in ONE war  : 15.8s  (0.95/s)
    30 paints in TWO wars : 16.3s  (1.84/s)

Almost exactly double. The lock is per war.

### Why the sequence is not the thing to change

Migration 001 already answers this: `last_seq` is allocated inside the paint
transaction and not by a `BIGSERIAL` because **"BIGSERIAL hands out values
before commit, so a client polling ?since= could step over a row that
committed late and lose it for good."** The diff protocol needs a gapless,
monotonic sequence, and the serialisation is what that costs. Trading it away
would trade a throughput ceiling for silently lost pixels.

### The number that matters in production

> **THIS IS A DERIVATION, NOT A MEASUREMENT OF PAINT.** Measured 2026-09-01.
> Nothing here observed a paint under load. What was measured is the round
> trip from a deployed function to Neon; the ceiling is then arithmetic on top
> of it. **Replace it with the first real war** — see "How the first real war
> replaces this number" below.

**Two measurements, before and after co-locating the functions with the
database, taken the same day with the same script against production.**

| | Functions in `iad1` (us-east-1) | Functions in `cle1` (us-east-2) |
| --- | --- | --- |
| Probe A, 1 free query | 16.25 ms | 3.33 ms, then 0.54 ms |
| Probe B, 4 queries / 4 | 15.52 ms | 2.45 ms, then 1.84 ms |
| Round trip | **15-16 ms** | **about 2 ms** |
| Ceiling `1 / (5 × RTT)` | **12-13 / s** | **roughly 80-110 / s** |

**The before column is solid and the after column is not, and the reason is
the method rather than the network.** Before, one round trip was 16 ms against
a per-sample jitter of ~15 ms, so both probes resolved it and agreed to 0.3%.
After, one round trip is ~2 ms against the same jitter, and probe A — which
divides a single query difference by 1 — returned 3.33 ms and then 0.54 ms on
consecutive runs, and once came out BELOW probe B, which cannot happen if
either is measuring what it claims. Probe B divides by four and stayed within
0.6 ms across both runs, so it is the number to quote.

**What is safe to say:** the cross-region hop is gone, the round trip fell by
roughly a factor of six, and the ceiling is now several times higher than the
paint path is ever likely to need. **What is not safe to say is which number
between 50 and 110 it is** — that is below the resolution of a measurement
taken from a laptop in São Paulo, and it needs the first real war.

**What was measured.** Two endpoints on one deployed preview, same region,
same session, differing only in how many sequential database round trips they
make. Everything that is not a database round trip — the hop to the edge, the
function invocation, TLS, JSON serialisation — is common to both and cancels
in the difference.

| Probe | Pair | Extra queries | Median difference | Implied round trip |
| --- | --- | --- | --- | --- |
| A | `/api/diff?since=head-1` vs `since=999999` | 1, an index scan on `pixel_events_pkey` costing **0.064 ms** by `EXPLAIN ANALYZE` | 13.7 ms | **13.7 ms** |
| B | `/api/leaderboard` vs `/api/diff?since=999999` | 4 aggregations and a LATERAL join | 55.1 ms | **13.8 ms** |

Two probes with completely different query shapes agreeing to within 0.3% is
the result. A is the trustworthy one — its extra query is free, so its
difference is network and almost nothing else. B is round trip **plus** mean
query cost, so B ≥ A by construction; that they are equal says server-side
execution is negligible beside the network, which is the same thing the
`EXPLAIN` says.

**Interval, and it is a spread rather than a confidence interval.** Runs of
60, 80 and 220 samples, interleaved one endpoint at a time so drift lands on
every series equally. Before the move: run medians of 13.8, 15.5 and 16.1 ms
with a p25/p75 spread of 9.4–18.6 ms. After: probe B medians of 2.45 and
1.84 ms, with a spread that crosses zero — which is the honest signal that the
difference is now at the floor of what this method can see, not that the round
trip is sometimes negative.

**Why the old number was three times too high, and this is the actionable
part.** It assumed a 5 ms round trip, inferred from `/api/leaderboard`
answering about as fast as a static file. That inference was too coarse to
see what the difference method sees: **the functions run in `iad1`
(us-east-1, Virginia) and the Neon project is in `aws-us-east-2` (Ohio).**
Every one of those five round trips crosses regions. 14 ms is the ordinary
figure for that hop, and the measurement matches it almost exactly.

**So the first lever was not code, and it was pulled.** Co-locating the
functions with the database attacks all five round trips at once, and nothing
else on the revisit list does. `vercel.json` now pins `regions: ["cle1"]`,
which is us-east-2 — the same AWS region as the Neon project. The before and
after are the table above, measured rather than assumed.

**KEEP THE TWO TOGETHER IF EITHER MOVES.** The whole gain is that they are in
one region. Moving the Neon project, or dropping the `regions` pin from
`vercel.json` so functions fall back to the default, silently restores a 16 ms
hop and a ceiling six times lower — with no error and no failed deploy.
**`function-region.test.ts` is what stops it being silent**: it asserts the pin
is present and equal to the region the database is in, and it asserts this
paragraph still explains why, because a three-word pin nobody can find a reason
for is a pin somebody deletes as clutter. The live tell is `x-vercel-id` —
its second field is the function region, and it must be `cle1`.

**The rule is the pairing, not the string.** If the Neon project ever moves,
the pin and that test move with it in the same batch. Neither is "cle1
forever"; both are "the functions are wherever the database is".

**Counting caveat, in the honest direction.** `1 / (5 × RTT)` is this
document's own formula and counts the five statements after the sequence
update. The lock is actually held until COMMIT, and COMMIT is a sixth round
trip, so the true figure is nearer `1 / (6 × RTT)` — **12/s at 13.7 ms**. The
five-trip number is kept for continuity with the table above and should be
read as the optimistic end.

**What this still does not tell you.** Whether a real crowd ever approaches
it, what Neon's pooler does at that concurrency, and whether throughput
degrades gracefully or collapses. Those need paint under load, and paint under
load needs painters — the registration gate, the per-IP cooldown and the
subnet burst cap all sit in front of a synthetic load generator, and taking
them down would have meant setting secrets on a shared environment. That was
deliberately not done.

### How the first real war replaces this number

**The war measures it for free, but only if somebody writes the number down.**
Nothing currently logs it, so this is what to do rather than what to read.

**The number to compute:** peak sustained paints per second, in one war.

    -- Busiest single second the war ever had, per war.
    SELECT war_id,
           date_trunc('second', painted_at) AS second,
           count(*) AS paints
      FROM pixel_events
     GROUP BY 1, 2
     ORDER BY paints DESC
     LIMIT 20;

`pixel_events` already records every paint with `painted_at`, so **the data is
being collected today and no code has to change to get it.** Take the median
of the top handful rather than the single best second, which can be a burst
the pooler happened to absorb.

**Read it against three things, not one:**

1. **This derivation.** If the busiest second is far under 12/s, the ceiling
   was never approached and the number stays a derivation — say so rather than
   claiming it was confirmed.
2. **Refusals.** A war at its ceiling shows up as latency, not as errors, so
   the absence of 5xx proves nothing. The tell is paint latency climbing while
   the rate stays flat — the same signature the load test found.
3. **`ABUSE_RATE_PER_MINUTE`**, which is 120 (2/s) and was set as a guess
   against a ceiling that was itself wrong. The first war recalibrates both,
   and they are now known to be six times apart rather than twenty.

**When it is replaced, delete this section's derivation rather than adding to
it.** Two numbers for one quantity, one measured and one derived, is how the
40 survived being wrong for as long as it did.

### Trigger for revisiting

**A war sustained anywhere near its ceiling.** The known path is reducing the
number of round trips held under the lock — the five after the sequence
update are a `SELECT` of the previous owner, the pixel `INSERT`, the event
`INSERT` and two count updates, and some of those can move outside the lock
or merge. **Not** abandoning the gapless sequence, for the reason above.

`DATABASE_POOL_MAX` is 25 in production, raised from the default 10 after this
test. It is not the ceiling and was never the ceiling; it is headroom for the
announcement spike, and an environment variable change needs a redeploy to
take effect.

## The board signal reports, and nothing acts on it

**No threshold pauses a war, bans anybody, or slows a paint. The alert says
"look"; a human decides.**

The reason is not caution, it is that **a raid and an attack are the same
shape.** A community coordinating on Telegram to fill a corner of the board
produces exactly the signal an attacker produces — a burst of paints
concentrated in one region — and that is the single behaviour this whole
product exists to cause (DESIGN.md §1a). An automatic brake tuned to catch
the attack fires on every successful launch, which is to say it punishes the
case the product is for.

The alert's WORDING follows from the same fact and is part of the design: it
says the board is busy and names both possibilities, never "abuse". An
operator primed to expect an attack bans somebody on their best day; an
operator who learns the alert cries wolf ignores it on their worst.

### The thresholds are initial values and are meant to be wrong

| Setting | Default | What it means |
| --- | --- | --- |
| `ABUSE_WINDOW_MINUTES` | 10 | How far back the rate is measured |
| `ABUSE_RATE_PER_MINUTE` | 120 | Board-wide paints per minute worth a look |
| `ABUSE_CELL_PAINTS` | 60 | Paints inside one 10x10 cell worth a look |

They are environment variables rather than constants for exactly one reason:
**they are guesses and correcting them must cost a variable change, not a
deploy.** The only rate data that existed when they were chosen came from a
load test, which measured what the SYSTEM can do rather than what people do.

Concentration is the more useful of the two. A busy war is paints everywhere;
a picture is paints in one place, and whether the picture is a logo or a
swastika is a question only eyes answer.

**TRIGGER: the first real war recalibrates these numbers.** Watch what a
legitimate raid actually produces, then set the thresholds above it. Until
then, expect false alarms and treat each one as data rather than as a defect.

**Parked, with a door: if practice shows abuse that cannot wait for a human,
an automatic response becomes a future round WITH THAT DATA.** Not before —
the argument above says any brake built today would fire on the good case,
and only real numbers can show whether a brake exists that does not.

## Test fixtures once reached production

**Two wars titled "Fixture war" were found in the production database**,
created 2026-08-25 at 05:28 and 21:37 — after the `sameTarget` guard in
`vitest.setup.ts` already existed. They were removed on 2026-08-27 in one
transaction, with the endpoint asserted by id and the row count asserted
before and after: 2 wars, 1 war_token, 1 pixel, 1 pixel_event, 1
token_pixel_count.

**Which path wrote them cannot be determined from the data.** A test run
outside vitest, or an ad-hoc script reading `DATABASE_URL` from `.env.local`,
would both produce exactly this and leave the same trace, which is none.

**What WAS determined is that a hole was open**, and it is closed: the guard
asked whether the test database differed from the app database, which passes
when `DATABASE_URL` is unset. The suite now requires the target to carry a
`disposable_database` stamp that only `db:migrate:test` writes and that
production cannot have. See CLAUDE.md.

**The remaining exposure is ad-hoc scripts**, which nothing can guard against
from inside the repository — a script that reads `DATABASE_URL` and writes is
indistinguishable from the application doing its job. The discipline that
covers it is the one used for every destructive operation in this project:
assert the endpoint by id before writing, and count rows before and after.

## Registration: what is open, what was refused, what to watch

**The fee is `REGISTRATION_FEE_SOL`, in SOL, default 0.003, and `0` switches
it off without a deploy.** That door is in DESIGN.md §1a and in
`.env.example`; it is the first thing to reach for if the fee is visibly
killing volume at launch. Changing it does not change the code path — a
wallet is still required at zero — so switching it off is not a jump into an
untested variant.

**A dollar price was refused, not forgotten.** Charging "about fifty cents"
means a live SOL/USD feed inside the money path: an outage question ("can
nobody register while the feed is down?"), a staleness window, and a
manipulation surface, all to collect fifty cents. The USDC checkout avoids
the entire problem by being denominated in a dollar-pegged token; this path
cannot be, so it is denominated in SOL and the operator moves the number when
SOL moves. Revisit only if the fee's real value drifts far enough that the
number needs changing more often than a person wants to change it.

**An unclaimed payment is not recovered automatically, and that is the
trade.** An entry order carries a reference account so a recovery pass can
find a payment nobody confirmed; a registration has no order to find, so a
transfer whose payer closes the tab before `/api/register` answers leaves a
payment with no row. The payer can retry with the same signature — the route
is idempotent and will register them — and if they never come back it is a
hand-filed case like any other unmatched payment. **This is the reason the fee
is small.** If registrations start appearing in support, the fix is a
reference account and a recovery pass, not a bigger apology.

**A wallet that already registered and pays again is refused, and its money is
NOT taken as a fee.** `already_registered` says so in the message. Watch for
it: repeated instances mean the screen is failing to tell somebody they are
already registered, which is a UI bug wearing a payments costume.

**What to watch in the first war.** How many people who click a pixel go on to
register (the panel opens on a refused paint, so a refusal is the denominator
and a registration is the numerator); how many register but never paint; and
whether `verification_attempts` shows callers hammering `/api/register` with
signatures that verify to nothing — that counter is shared with the checkout,
so an attack on one spends the other's allowance.


## The build cache is never a published artifact

**`.next/cache` carries secrets. Do not upload it anywhere, ever — not as a CI
artifact, not in a debug bundle, not to a support ticket.**

The security audit grepped a real build and found `RATE_LIMIT_SALT`,
`PAINTER_COOKIE_SECRET` and `VERCEL_TOKEN` in eleven files each under
`.next/cache/turbopack/*.sst`. The build reads them from the environment and
the bundler's cache keeps what it saw.

**Nothing is wrong with the deployment.** The client bundle is clean — zero
matches across all 43 files in `.next/static`, against a control that proves
the search worked (`"PIXELWAR"` hit 3 client files, `"Show territory"` 1).
`.next/` is gitignored and Vercel does not serve `.next/cache`. The risk is
entirely in copying that directory somewhere else.

**So the rule is about what a person does next**, which is why it is written
here rather than fixed in code: if a build ever needs to be shipped for
diagnosis, ship `.next/static` and the server output, never `.next/cache`. And
if a cache directory has been shared, treat those three variables as disclosed
and rotate them — `PAINTER_COOKIE_SECRET` in particular, since forging painter
cookies is what it prevents.


## Pixelwar charges in SOL, on every surface

**Since 2026-08-31 there is no USDC anywhere in this product.** Admission is
SOL (migration 015, `wars.entry_price_sol`, in lamports) and the painter's
registration always was. The USDC verifier and transfer builder were deleted
rather than left dormant — see DECISIONES.md.

**THIS IS WHAT SEPARATES US FROM BIDOOR ON A SHARED WALLET.** Both products
receive at the same address, and they are now separated by denomination: a
bidoor bid is an SPL transfer that moves no native lamports to the wallet, and
a pixelwar payment is a native transfer that moves no USDC. Each side's
verifier reads the other's payments as nothing at all — tested from our side
in `registration.test.ts`, where a transaction crediting 500 USDC to the
wallet is refused.

**The consequence to keep in view:** that separation is a property of the two
denominations, not of anything either codebase enforces. If pixelwar ever
takes USDC again, or bidoor ever takes SOL bids, they collide the same day and
nothing in either repo will complain. That is the trigger for giving
registration a reference key of its own — the mechanism that would separate
them by construction instead.

## One receiving wallet, two products

**`PAYMENT_WALLET` is the same address bidoor.lol collects on. The owner's
decision: two products, one receiving wallet.** Three consequences follow, and
only the first is already handled.

**1. Pixelwar's reconcile cannot see a bidoor bid, and that is structural
rather than filtered.** Recovery asks the chain "what named this order's
reference key" — a fresh single-use address minted per order — never "what did
this wallet receive". A bid carries no pixelwar reference, so it is not
rejected as a candidate; it is never a candidate. `recover.test.ts` asserts
the address the pass asks about is the order's reference and never
`PAYMENT_WALLET`, so nobody can quietly turn that into a wallet scan for
convenience. **The thing to protect is the absence of a wallet scan**, and a
filter would be the weaker version of it.

**2. BIDOOR NEEDS THE MIRROR FILTER, AND NOBODY HAS WRITTEN IT.** If bidoor's
reconcile scans its wallet's history — which is the obvious way to find bids,
since a bid has no reference — then every pixelwar entry payment and every
pixelwar registration fee lands in bidoor's queue as an unattributable
receipt. The filter it needs is the mirror of ours: **ignore any transfer that
carries a Solana Pay reference account**, because that is pixelwar's money by
construction. Until that exists, expect pixelwar's payments to show up in
bidoor's unmatched pile.

**3. A BIDOOR BID CANNOT REGISTER ON PIXELWAR — TESTED, NOT ASSUMED.** This
was written here as an open blocker on the strength of "any transfer to the
shared wallet clears the fee check". That was wrong in the one detail that
decides it: **bidoor takes bids in USDC**, which is an SPL transfer between
token accounts, and `verifySolTransfer` reads NATIVE lamports out of
`preBalances`/`postBalances`. A USDC transfer moves no SOL to
`PAYMENT_WALLET` — a token account is a different account — so the reader
sees a lamport delta of zero and answers `no_transfer`.

`registration.test.ts` proves it in the shape that could have gone wrong: a
transaction whose token balances credit 500 USDC to `PAYMENT_WALLET`, with the
wallet itself among the account keys, is refused with "did not send SOL", and
a real SOL transfer in the same file still registers — the control, without
which both refusals would also pass against a verifier that refuses
everything.

**So the reference key on a registration transfer is an IMPROVEMENT, not a
blocker.** What it would buy, and why it is still worth doing later:

- **Recovery.** A registration payment whose payer closed the tab is currently
  a hand-filed case, because there is nothing on the transfer to find it by.
  A reference key gives registration the same recovery pass the checkout has.
- **A clean rule for bidoor.** "Ignore transfers carrying a reference" is
  simpler for the other side than reasoning about denominations.
- **Denomination independence.** The refusal above holds because bidoor bids
  in USDC and we charge in SOL. If bidoor ever takes SOL bids, that stops
  being true the same day, with nothing in this repo changing. **That is the
  trigger to revisit** — not a date, an event.

**One more fact about the wallet, recorded because it dates the whole
question**: at the time of writing, `7ozy…UVgi` does not exist on mainnet — it
has never received anything. So none of this is historical clean-up; it is
about payments neither product has taken yet.


## The dress rehearsal before every money-path change

**Before anything that touches how money is taken — a new denomination, a new
verifier, a price change, a change to how an order is created or settled — a
throwaway war runs the whole flow on PRODUCTION, with real money, and is
cleaned up afterwards.**

A preview proves the code runs. It cannot prove that a wallet, a real RPC
provider, the real receiving address and this deployment's own configuration
agree with each other — and that is the half that costs money when it is
wrong.

**The war.** Made with `createWar` rather than an INSERT, because opening a
war is itself part of the path being rehearsed. An obvious test name so no
visitor mistakes it for the real thing, the smallest price the schema allows,
an hour long, and not announced anywhere.

**The five steps, in this order**, because each one can only fail after the
one before it has worked:

1. **Connect** from the header.
2. **Pay** the admission through `/join`.
3. **Paint** — which needs the painter registration, a separate charge.
4. **Close the tab and come back**: the second visit must recognise the
   registration without asking for a second payment.
5. **Try to pay again**: this must be REFUSED, and the refusal is the point of
   the rehearsal rather than a formality.

**What is checked server-side after each step** — the screen saying it worked
is not the evidence:

- the order exists, `pending`, with the war's price in `amount_lamports`;
- the payment matched the payer's own wallet, and the order is `paid` with a
  row in `payments`;
- the second attempt landed on the RIGHT refusal (`already_entered` for the
  same token, `already_settled` for the same signature) — a refusal for the
  wrong reason is a failed rehearsal;
- **`unmatched_payments` is empty.** A row there means real money reached the
  wallet and was credited to nobody, which is the failure this whole exercise
  exists to catch before strangers are the ones it happens to.

**Afterwards** the war is ended and its pixels removed, so the board carries
no rehearsal.

**The smallest price is not always payable.** There is deliberately no CHECK
on `wars.entry_price_sol`, so the schema floor is one lamport — but a transfer
to an account that does not exist yet must carry the rent-exempt minimum
(890,880 lamports at the time of writing) or the transaction fails on chain.
Check whether the receiving wallet exists before choosing a price of dust.

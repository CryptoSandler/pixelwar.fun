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

## The sybil price is the token, not a fee

**Painting is not charged for, and the identity that is expensive to replace
is the sworn wallet.** A proposal to charge a small registration fee as an
anti-sybil measure was weighed and refused on this ground: the expensive
identity already exists, thirty sworn identities cost thirty token purchases,
and that money goes to the community rather than to us — which is DESIGN.md
§1a working as written rather than an exception to it.

What was missing was that moderation could not name a wallet. `bans` accepted
`painter`, `ip` and `subnet`, and every one of those is shed by clearing a
cookie or changing network. Migration 011 adds `wallet`, and a banned wallet
cannot swear itself back in — without that the ban would be a ceremony, since
the offender re-swears the same wallet and recovers the badge.

**Reach for the wallet key first when it exists.** It is the only one that
costs something to replace. Most painters are recruits with no wallet, and
that is the volume rather than a lesser state.

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

## The write ceiling is ~40 paints per second, per war

**Measured, and it is architectural rather than a setting.** Every paint takes
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

The table above was measured at 173ms per round trip, which is this
developer's latency to Neon and **not** the deployment's. Derived from
production rather than assumed: `robots.txt` (static, no database) answers in
0.14s and `/api/leaderboard` (four queries) answers in 0.12-0.13s — the
queries are indistinguishable from a static file, so the round trip is on the
order of 5ms.

**That projects to roughly 40 paints per second per war**, which is about
1,200 active painters on a 30-second cooldown. It is a projection from a
derived round trip, not a measurement of paint under load on Vercel; the
preview deployment is behind SSO and was deliberately not exposed to measure
it. The first real war measures it for free.

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

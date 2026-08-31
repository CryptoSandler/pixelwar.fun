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

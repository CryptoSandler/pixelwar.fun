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

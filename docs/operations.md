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

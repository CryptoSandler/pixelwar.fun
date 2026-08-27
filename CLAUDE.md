@AGENTS.md

# Talking to the user

Every message you send to the user starts with the line `[pixelwar.fun]` on its
own, before anything else, so the user can tell which project is talking when
several Claude Code sessions run in parallel.

## Default posture: lazy senior

A skill only fires when the model judges it relevant, and this applies to every change, so
the short version lives here rather than in `~/.claude/skills/ponytail/`.

Before writing code, climb until a rung holds, and stop at the first one that does:

1. Does this need to exist at all? Speculative need: skip it, and say so in one line.
2. Does this repo already have it? Reusing what lives a few files over beats re-implementing it.
3. Does the standard library do it?
4. Does a native platform feature cover it? A DB constraint over app code, CSS over JS.
5. Does an already-installed dependency solve it? Never add one for what a few lines cover.
6. Can it be one line?

If no rung holds, write the minimum that works.

The level here is **lite**: build what was asked, and name the lazier alternative in one
line so the choice stays with the user. Nothing gets silently downscoped into something
smaller than what was requested.

Every deliberate shortcut carries a comment naming its ceiling and its upgrade path, so the
next reader knows it was a decision and not an oversight:

    // ponytail: linear scan, index it if the list outgrows a few hundred entries

Four things are never simplified away, at any level: input validation at trust boundaries,
security, error handling that prevents data loss, and accessibility basics. Laziness governs
how much code gets written. It never governs what that code is allowed to skip.

# Before building: one round with no code

**A change to the data model, or a product decision of any size, gets an
adversarial round before a line is written. Not a plan — an argument.** Three
things are asked for explicitly, and the round is not closed until all three
have answers:

1. **The strongest case AGAINST.** Not caveats, not risks-and-mitigations. The
   version of "this is the wrong thing to build" that would actually change
   the decision if it were true.
2. **The collision with the real code.** What survives, what gets thrown away,
   and — the one that pays for the round — *what does the repo already know
   that the discussion does not.*
3. **An honest recommendation, with standing permission to say the idea is
   wrong.** A round that can only produce "yes, and here is how" is a round
   that produced nothing.

**Why this is a rule and not a habit.** The third question is the one that
keeps earning it. "Free palette" arrived as a data-model rewrite and the repo
already had `pixels.war_token_id` from migration 001 — attribution was never
derived, only the colour was, so the change was one column instead of a new
model. Nothing in the brief could have known that; twenty minutes of reading
did. In the other direction, a batch brief specified the accent as
`#B87A1E` — a value `chrome.ts` had already recorded as superseded for failing
WCAG AA on its own button at 4.31:1. Building it first and discovering that
second would have shipped a measured defect that this repo has a whole
invariant suite to prevent.

The round costs a message. Not having it costs a batch.

# Every verdict cites the written norm

**A gate, a critique or a design verdict is made against the normative
document OPEN — DESIGN.md, this file, the migration, the spec — never against
a memory of what it says. A verdict that cannot quote the line has not earned
the right to be a verdict yet: read the document first.**

This cuts both ways, and the second way is the one people miss.

**A citation can be stale.** DESIGN.md §1 and §2 said "twenty-four
communities each hold one colour" and "they belong to tokens" for a full batch
after that stopped being true. Anybody quoting those lines in good faith would
have been quoting a document that no longer described the product. So the rule
is not "the document wins" — it is *open the document, and check it against
the code it claims to govern.* Where they disagree, one of them is a bug, and
saying which is the verdict.

**Memory reliably produces a plausible wrong number.** The brass above is the
clean example: `#B87A1E` was real, was written down somewhere, and was wrong,
and no amount of confidence would have surfaced the 4.31:1 that decided it.
The number is in `chrome.ts` and takes one grep.

# Decisions with a door

**When the owner is not convinced of a one-way decision — a promise in copy, a
prohibition, a guarantee, anything the product cannot walk back — do not
decide it for them.** Three moves, in order:

1. **Find the neutral wording**: text that neither promises nor forbids, and
   is honest in both futures.
2. **Build the mechanism that fits both.** The code should not need rewriting
   whichever way the policy lands.
3. **Record the policy as the owner's open decision**, somewhere an operator
   reads — not buried in a commit message.

**The irreversible sentence gets written once, and only when it is asked for
explicitly.**

The token admission cap is the worked example. The ceiling in the schema is
255, which is arithmetic and not taste: the territory layer names a pixel's
owner in one byte and reserves 0 for unpainted. The *policy* — keep wars at 24
or fewer while the palette has 24 colours, so no two tokens fly the same flag
— lives in `docs/operations.md` and on the admin screen beside the input.

Putting 24 in a `CHECK` would have been the door slammed: a limit imposed by
the length of a colour list, frozen into the database, changeable only by
migration, and unreadable afterwards as to whether it was a decision or an
accident. It had been an accident for the entire life of the project until
migration 008 removed it. A rule an operator can read and break is a rule that
can be revisited; a constraint is a rule that has to be excavated.

# Every new module names its caller

**A brief that creates a function, a job, or a route says who invokes it. If
the answer is "a later task", that task is named. If the answer is "nothing
yet", the brief says so out loud.**

Batch B built `expireStaleOrders` and `recoverUnclaimedOrders`. Both were
finished, tested, and passed independent review — one of them through three fix
rounds. Neither had a caller anywhere in the application. One task built the
expirer, another the recoverer, a third the routes, and no brief owned the
wiring, so nobody was wrong and the feature did not exist.

The consequence chained further than it looks: with nothing calling the
expirer, no order ever reached `expired`; with no order in `expired`, the
recovery pass's own candidate query was empty by construction; so the
late-confirm reclaim, the unmatched-payment filing and the whole of migration
`004` were unreachable in production. Eleven scoped reviews missed it, because
each one was asked whether its task was correct and none was asked whether it
was reachable.

Two habits follow:

1. **A unit test of a function cannot catch this, and did not.** The test that
   catches it asserts the *wiring*: drive the caller, not the callee, and
   assert the effect. Falsify it by deleting the call.
2. **"Who calls this?" is a review question**, asked of every new module, and
   answered with a file and a line rather than an intention.

# Test databases: one per branch that migrates

**A branch that adds a migration runs against its OWN Neon test branch — a
child of `production`, migrated to that branch's level, deleted when the
branch merges. Branches that add no migration share `tests`.**

This is not tidiness. Two unmerged branches sharing one test database means
the one that migrates decides the schema for the one that does not, and the
second branch fails on a column its code predates. That happened here:
`paleta-libre` added `pixels.colour_slot NOT NULL`, and
`reconciliacion-sin-scheduler` — correct, unchanged, already green — started
failing seventeen tests whose fixtures had never heard of the column. Nothing
was wrong with the branch. The close would have reported a defect that did
not exist, or worse, reported "it passed earlier" and been believed.

The fix took one Neon branch off `production` and a `TEST_DATABASE_URL`
override for one run: 538/538, green, in fifteen minutes. The habit is
cheaper than the diagnosis every time.

**Merge order follows from this and is not optional.** The branch without
migrations merges first; the one with them rebases on top and re-runs. The
reverse puts the migration-free branch on a `main` whose database has already
moved, which is the same failure with more steps.

## Concurrent runs against the shared database

`fileParallelism: false` in `vitest.config.mts` stops files inside ONE run
from racing. It does nothing about two runs — two sessions, two terminals,
two repos — and those truncate each other's fixtures mid-assertion. A Postgres
advisory lock, held for the length of a run, makes the second run wait instead
of interleave.

Three things about that lock are load-bearing:

- **THE LOCK LIVES IN `vitest.global-setup.ts`, NEVER IN `setupFiles`.**
  `setupFiles` runs once per test FILE. A lock taken there is taken and
  released once per file — N connections to the direct endpoint, and the lock
  sitting FREE in every gap between files, which is precisely where a second
  run slips in. It protects less than it appears to while costing more than it
  looks, and it passes a naive check: look at `pg_locks` mid-run and the lock
  is genuinely held, because you happened to look during a file rather than
  between two. `globalSetup` runs once per run and its returned teardown runs
  once at the end. This was written here as `setupFiles` first, and a hung
  suite is what found it.
- **It is taken on a DIRECT connection, not the pooled one.** Neon's pooled
  endpoint is PgBouncer in transaction mode, which hands one server connection
  to a different client between transactions — a session-level lock taken
  through it is released at a moment nobody controls. It would appear to work
  and protect nothing. `directUrl()` strips `-pooler` for exactly this.
- **It waits with a ceiling, and says which situation it is.** A run that hung
  and a run that is genuinely still going need different responses from
  whoever is reading the terminal.

**Verify it by BEHAVIOUR, not by a snapshot.** The check that means something
is: with a run in flight over SEVERAL files, a third connection's
`pg_try_advisory_lock` returns `false` throughout, and `true` once the run
ends. A single `pg_locks` reading proves only that the lock existed at the
instant you looked — which is exactly what the broken version also does.

**Never `pkill -f vitest`.** It matches every repo on the machine. Doing it
here killed two other projects' suites mid-run. Kill by PID.

# Migrations

**Never change the SQL of a migration that has already been applied. Add the
next number.**

`scripts/migrate.mts` records applied versions and skips them, so editing an
applied file fixes the file and nothing else. Every database that already ran
the old version keeps the old schema, silently, and the file now lies about
what those databases contain. It looks fine locally because the local database
is the one you just repaired by hand.

This is not hypothetical. Migration `004` shipped an index whose column order
could not serve the query it was written for, was corrected in place, and was
re-applied by hand to two databases. Both are correct now and no other database
existed — which is the only reason it cost nothing. A third database would have
been wrong with nothing to show for it, because no test asserts an index exists.

If you have already changed an applied migration's SQL, say so plainly, then
either add the corrective migration or state exactly which databases you
repaired and how you verified them.

**`--` comments are the exception, and only because they cannot diverge.** No
database stores one, so correcting one cannot make the file disagree with
anything. `COMMENT ON` is not a comment for this purpose — its text lives in
the catalog, so changing it is changing the schema and takes the next number
like any other DDL. But reach for that rarely, and notice what it usually means: a
migration comment that has gone stale is normally a comment that described
behaviour living in another file. Migration `004` said an over-age payment was
"never recovered and never filed", which was true of `recover.ts` when it was
written and false a batch later. **A migration comment should describe the
schema, not the policy some module applies to it** — the schema is frozen by
definition and the policy is not.

# Showing the network before a signature

**Classify to a cluster name. Never pass the upstream URL. If you cannot
classify with confidence, say "unknown" and block the signature.**

The browser only ever talks to `/api/rpc`, so it cannot see which cluster the
proxy is pointed at. A deployment whose `SOLANA_RPC_URL` points at devnet will
show "Solana mainnet" on an ordinary origin, and nothing client-side can tell.
The reverse is worse: an origin the wallet adapter maps to a local cluster
while the screen says mainnet lets a wallet sign against a chain the payer was
not shown.

Two things follow, and both matter:

1. **The cluster is classified server-side and passed down as a name.** Not the
   URL, not the host, not a fragment of either. `/api/rpc` carries a fix whose
   entire purpose is that nothing of the upstream reaches the browser — no
   URL, no key, no raw provider body, on any status code. Passing the endpoint
   down to label a screen undoes that from the other direction.

2. **Refusing to sign is the safe failure.** A disclosure that can be silently
   wrong is worse than no disclosure, because it is trusted. When the derived
   chain and the classified upstream disagree, or when either is unknown, block
   and say why. A payer who cannot pay will ask. A payer who paid on the wrong
   chain will not know to.

The same rule covers any future "which network am I on" surface: the answer
comes from the server that holds the connection, and uncertainty blocks.

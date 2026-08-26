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

# Migrations

**Never edit a migration that has already been applied. Add the next number.**

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

If you have already edited an applied migration, say so plainly, then either
add the corrective migration or state exactly which databases you repaired and
how you verified them.

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

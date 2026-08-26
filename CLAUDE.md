@AGENTS.md

# Talking to the user

Every message you send to the user starts with the line `[pixelwar.fun]` on its
own, before anything else, so the user can tell which project is talking when
several Claude Code sessions run in parallel.

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

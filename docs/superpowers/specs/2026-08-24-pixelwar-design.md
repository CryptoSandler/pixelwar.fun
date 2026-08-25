# pixelwar.fun — design

**Status:** approved in outline, pending review of this document
**Date:** 2026-08-24

r/place for memecoin communities, run as timed wars. A community buys its token
into a war with one USDC payment and receives one colour out of twenty-four.
Painting is free. Every pixel is attributed to a token, so the canvas is a
live scoreboard of which community showed up. The war ends, the canvas freezes,
and the result is a ranking and a shareable image.

The domain is the brand: pixelwar.fun, and `SITE_URL`.

Read [`docs/references.md`](../../references.md) alongside this. It records what
rplace.live and wplace.live actually do and which of it we take.

## 1. What a war is

A war has a start, an end, a 200×200 canvas, an entry price, and a paint
cooldown. Everything except the canvas dimensions is set per war by an
operator; there is no default price or duration in code, because a default
price is a price somebody eventually charges by accident.

Up to 24 tokens per war, one colour each. A token joins by paying the entry
price in USDC on Solana and choosing a free colour. Registration stays open for
the whole war — before it starts and while it runs — and closes by itself when
the colours run out or the war ends. There is no minimum: a war starts with
whatever has paid, and rescheduling an empty one is an operator's decision, not
a rule the software enforces.

Anyone can paint, for any token, with no account. A painter picks a token, taps
a pixel, and waits out the cooldown. Painting for a token is not restricted to
its holders — organising the crowd is the community's job, and that is the game.

Pixels are overwritten freely. Ownership is current occupancy: the leaderboard
ranks tokens by pixels they hold right now, with pixels ever placed as a
secondary figure. This rewards defending territory over spraying it, which is
the behaviour that makes the canvas worth looking at.

## 2. What we inherit from bidoor

Copied close to verbatim, with names adapted:

- `lib/db.ts` — pool, `transaction`, `isUniqueViolation`, `violatedConstraint`.
- `lib/payments/solana.ts` — `verifyPayment`, written against token-balance
  deltas rather than instruction shape, and returning `SenderInfo` on failure.
- `lib/payments/limits.ts` — `clientIp` (reads `x-forwarded-for` from the
  right), `hashIp`, the verification limiter.
- `lib/admin.ts` — revocable sessions, login lockout counted from the most
  recent failures, digest-comparison of tokens, append-only audit log.
- `lib/chains.ts` — the eight chains and their DexScreener identifiers.
- `lib/dexscreener.ts` — canonical metadata, and the existence check.
- `lib/addresses.ts`, `lib/links.ts`, `lib/format.ts`, `lib/slug.ts`.
- `next.config.ts` security headers, `scripts/migrate.mts`, the reconcile
  GitHub Actions workflow, the shape and commenting style of `.env.example`.

Adapted:

- **Payment binding.** bidoor allocated a unique cent fraction per bid and
  matched payments by amount. Here the binding is the transaction signature
  plus the payer's public key, so `FRACTION_*`, `paymentBaseUnits` and the
  amount-saturation limits all go away.
- **Overpayment is accepted.** bidoor treats `overpaid` as a failure. A fixed
  entry price with no unique fraction has no reason to reject extra; it is
  recorded and applied.
- **Rate limits.** bidoor limited bid creation. Here the hot path is painting,
  which needs a different limiter entirely (§7). Order creation reuses the
  bidoor shape.

Dropped: the ranking and board modules, presence, stats, the token click-out
and slug redirects, seeds tied to bidoor's fixture.

## 3. Data model

Postgres, `pg`, no ORM — the same reasoning as bidoor: the SQL is meant to be
read line by line.

### Wars

```sql
CREATE TABLE wars (
  id               TEXT PRIMARY KEY,
  slug             TEXT        NOT NULL UNIQUE,
  title            TEXT        NOT NULL,
  status           TEXT        NOT NULL DEFAULT 'draft'
                     CHECK (status IN ('draft','scheduled','live','ended','cancelled')),
  width            INTEGER     NOT NULL DEFAULT 200,
  height           INTEGER     NOT NULL DEFAULT 200,
  max_tokens       SMALLINT    NOT NULL DEFAULT 24 CHECK (max_tokens BETWEEN 1 AND 24),
  -- No DEFAULT, deliberately. An entry price that a deploy can forget to set
  -- is an entry price somebody charges by accident.
  entry_price_usd  INTEGER     NOT NULL CHECK (entry_price_usd > 0),
  cooldown_seconds INTEGER     NOT NULL CHECK (cooldown_seconds BETWEEN 1 AND 3600),
  starts_at        TIMESTAMPTZ NOT NULL,
  ends_at          TIMESTAMPTZ NOT NULL,
  -- Monotonic, gapless, allocated inside the paint transaction. See §6.
  last_seq         BIGINT      NOT NULL DEFAULT 0,
  created_at       TIMESTAMPTZ NOT NULL,
  ended_at         TIMESTAMPTZ,
  CHECK (ends_at > starts_at)
);
```

Exactly one war may be `live` or `scheduled` at a time in v1; the constraint is
enforced in the admin path rather than by a partial unique index, so an
operator can prepare the next war as a draft while one runs.

### Tokens in a war

One row per token per war, holding the colour. A reservation and a paid entry
are the same row at different statuses, so the colour is held by the database
between the two rather than by application logic.

```sql
CREATE TABLE war_tokens (
  id                  TEXT PRIMARY KEY,
  war_id              TEXT        NOT NULL REFERENCES wars (id),
  chain_id            TEXT        NOT NULL,
  contract            TEXT        NOT NULL,
  contract_key        TEXT        NOT NULL,   -- normalised; lowercased for EVM
  colour_slot         SMALLINT    NOT NULL CHECK (colour_slot BETWEEN 1 AND 24),
  status              TEXT        NOT NULL DEFAULT 'reserved'
                        CHECK (status IN ('reserved','active','removed','released')),
  name                TEXT        NOT NULL,
  ticker              TEXT        NOT NULL,
  logo_url            TEXT,
  links               JSONB       NOT NULL DEFAULT '{}'::jsonb,
  metadata_fetched_at TIMESTAMPTZ NOT NULL,
  reserved_at         TIMESTAMPTZ NOT NULL,
  joined_at           TIMESTAMPTZ,
  released_at         TIMESTAMPTZ,
  released_reason     TEXT
);
```

The four statuses are not interchangeable, and the difference matters:

- `reserved` — paid for by nobody yet. Holds its colour until the order expires.
- `active` — paid, listed, painting.
- `released` — a reservation that expired unpaid. **Frees its colour**, which is
  the whole point of the partial predicate: nothing was ever painted in it, so
  reissuing the colour cannot mislead anyone.
- `removed` — an operator pulled a token that had been `active`. Its colour is
  **retired for the rest of the war** and its pixels are cleared in the same
  transaction (§10). Reissuing a colour that already has pixels on the board
  would silently transfer one community's territory to another, and a
  leaderboard built on that is worse than no leaderboard.

So the colour index frees on `released` only, while the contract index treats
both as gone — a token pulled for cause does not buy its way back into the same
war.

```sql
CREATE UNIQUE INDEX war_tokens_colour_live
  ON war_tokens (war_id, colour_slot) WHERE status <> 'released';

CREATE UNIQUE INDEX war_tokens_contract_live
  ON war_tokens (war_id, contract_key) WHERE status <> 'released';
```

### Orders and payments

```sql
CREATE TABLE entry_orders (
  id             TEXT PRIMARY KEY,
  war_id         TEXT        NOT NULL REFERENCES wars (id),
  war_token_id   TEXT        NOT NULL REFERENCES war_tokens (id),
  amount_usd     INTEGER     NOT NULL CHECK (amount_usd > 0),  -- price snapshot
  -- Set when the order is created from a connected wallet. The transaction
  -- must have been funded by this key. See §5.
  payer_pubkey   TEXT,
  ip_hash        TEXT,
  status         TEXT        NOT NULL DEFAULT 'pending'
                   CHECK (status IN ('pending','paid','expired','failed')),
  failure_reason TEXT,
  created_at     TIMESTAMPTZ NOT NULL,
  expires_at     TIMESTAMPTZ NOT NULL,
  paid_at        TIMESTAMPTZ
);
CREATE UNIQUE INDEX entry_orders_token_unique ON entry_orders (war_token_id);
CREATE INDEX entry_orders_status ON entry_orders (status, expires_at);
```

`consumed_signatures`, `payments`, `unmatched_payments` and
`verification_attempts` come from bidoor unchanged except that `bid_id` becomes
`order_id`. `payments.signature` stays `UNIQUE`, and that constraint is the
thing that makes a signature single-use across the whole system.

### Canvas

```sql
CREATE TABLE pixels (
  war_id       TEXT        NOT NULL REFERENCES wars (id),
  idx          INTEGER     NOT NULL,              -- y * width + x
  war_token_id TEXT        NOT NULL REFERENCES war_tokens (id),
  seq          BIGINT      NOT NULL,
  painted_at   TIMESTAMPTZ NOT NULL,
  painter_key  TEXT,                              -- nulled by retention
  ip_hash      TEXT,                              -- nulled by retention
  PRIMARY KEY (war_id, idx)
);

CREATE TABLE pixel_events (
  war_id       TEXT        NOT NULL REFERENCES wars (id),
  seq          BIGINT      NOT NULL,
  idx          INTEGER     NOT NULL,
  colour_slot  SMALLINT    NOT NULL,              -- denormalised: the diff needs
  painted_at   TIMESTAMPTZ NOT NULL,              -- no join to answer
  PRIMARY KEY (war_id, seq)
);

CREATE TABLE token_pixel_counts (
  war_id       TEXT     NOT NULL REFERENCES wars (id),
  war_token_id TEXT     NOT NULL REFERENCES war_tokens (id),
  owned        INTEGER  NOT NULL DEFAULT 0,
  placed       INTEGER  NOT NULL DEFAULT 0,
  PRIMARY KEY (war_id, war_token_id)
);
```

`pixel_events` is append-only and never pruned while a war is live; it is the
diff feed today and the timelapse later. A flat `idx` rather than `(x, y)` is
half the bytes on the wire and the format the renderer wants anyway.

`token_pixel_counts` is maintained inside the paint transaction — decrement the
previous owner, increment the new one — and recomputed from `pixels` by the
reconcile job, so a bug in the increment path is repaired rather than
compounded.

### Painters, cooldowns, bans, reports

```sql
CREATE TABLE paint_cooldowns (
  war_id           TEXT        NOT NULL REFERENCES wars (id),
  key_type         TEXT        NOT NULL CHECK (key_type IN ('painter','ip','subnet')),
  key              TEXT        NOT NULL,
  last_painted_at  TIMESTAMPTZ NOT NULL,
  window_start     TIMESTAMPTZ NOT NULL,
  window_count     INTEGER     NOT NULL DEFAULT 0,
  PRIMARY KEY (war_id, key_type, key)
);

CREATE TABLE bans (
  id         TEXT PRIMARY KEY,
  key_type   TEXT        NOT NULL CHECK (key_type IN ('painter','ip','subnet')),
  key        TEXT        NOT NULL,
  reason     TEXT,
  actor      TEXT        NOT NULL,
  created_at TIMESTAMPTZ NOT NULL,
  expires_at TIMESTAMPTZ
);
CREATE UNIQUE INDEX bans_key ON bans (key_type, key);

CREATE TABLE content_reports (
  id          TEXT PRIMARY KEY,
  war_id      TEXT        NOT NULL REFERENCES wars (id),
  x           INTEGER     NOT NULL,   -- the rectangle being reported,
  y           INTEGER     NOT NULL,   -- not a person: we have no accounts
  w           INTEGER     NOT NULL CHECK (w > 0),
  h           INTEGER     NOT NULL CHECK (h > 0),
  reason      TEXT        NOT NULL CHECK (octet_length(reason) <= 280),
  ip_hash     TEXT,
  created_at  TIMESTAMPTZ NOT NULL,
  resolved_at TIMESTAMPTZ,
  resolved_by TEXT
);
```

### Snapshots

```sql
CREATE TABLE war_snapshots (
  war_id     TEXT PRIMARY KEY REFERENCES wars (id),
  canvas     BYTEA       NOT NULL,   -- one byte per pixel, palette slot
  ranking    JSONB       NOT NULL,
  created_at TIMESTAMPTZ NOT NULL
);
```

Written once, on close, and never updated. An archived war reads from here and
never touches `pixels`, so archive pages cost one row.

Admin tables (`admin_sessions`, `admin_login_attempts`, `admin_audit_log`) are
bidoor's, unchanged.

## 4. The palette

Twenty-four colours, index `0` reserved for unpainted.

These are the r/place 2022 colour values, which the whole lineage of clones has
converged on. Stating that plainly is better than pretending otherwise: they
are here because a decade of collective pixel art has proven they stay
distinguishable at one-pixel size, and a list of hex values is not the part of
anyone's work worth protecting. They are a **starting point for the visual
design pass**, which owns pixelwar.fun's identity and may replace them
outright — the only hard requirements are twenty-four of them and mutual
distinguishability on our canvas ground.

| # | Hex | # | Hex | # | Hex |
| --- | --- | --- | --- | --- | --- |
| 1 | `#BE0039` | 9 | `#00756F` | 17 | `#811E9F` |
| 2 | `#FF4500` | 10 | `#009EAA` | 18 | `#B44AC0` |
| 3 | `#FFA800` | 11 | `#00CCC0` | 19 | `#FF3881` |
| 4 | `#FFD635` | 12 | `#2450A4` | 20 | `#FF99AA` |
| 5 | `#FFF8B8` | 13 | `#3690EA` | 21 | `#6D482F` |
| 6 | `#00A368` | 14 | `#51E9F4` | 22 | `#FFB470` |
| 7 | `#00CC78` | 15 | `#493AC1` | 23 | `#000000` |
| 8 | `#7EED56` | 16 | `#6A5CFF` | 24 | `#FFFFFF` |

### Slot 0 is the canvas, not a colour

Slot `0` means *unpainted*. It renders as the canvas ground and no token is
ever assigned it, so it is not in the table above and never appears in a token
picker.

Its value is a neutral that belongs to the canvas itself — **`#2E2E38`**, a
cool slate — and it is bound by three rules:

- It must not equal any of the twenty-four token colours.
- It must not be pure black or pure white. Both are real token colours (23 and
  24), and beyond that, an empty board that is pure white reads as "broken
  render" and one that is pure black reads as "nothing loaded".
- It must stay far enough from every token colour to be unmistakable at one
  pixel. The floor is a minimum RGB distance, asserted in a unit test over the
  whole palette, so a future design pass cannot quietly pick a ground that
  collides with a token.

The point is that a viewer must never have to wonder whether a region is
somebody's territory or empty space. The neutral is deliberately unlike
anything a token can hold: no token colour in the table is desaturated, so a
grey-slate ground can only mean nobody has been here.

The same test guards the token palette against itself — twenty-four entries, no
duplicates, all distinct from slot `0`.

The palette is *not* a colour picker. A painter selects a **token**; the colour
follows from which token they picked. This is the whole attribution model: the
canvas bytes are palette slots, palette slots map to tokens, so the canvas is
the attribution with no second data structure.

## 5. Entry and payment

The flow follows DexScreener's: connect a wallet, click one button, sign, done.
Pasting a signature by hand is a collapsed fallback, not the main path.

1. **`POST /api/orders`** — `{ warSlug, chainId, contract, colourSlot,
   payerPubkey? }`.
   - Address shape validated per chain family.
   - DexScreener resolves the token. Not found means not listable: the metadata
     is canonical and doubles as the existence check, so nobody types their own
     name and ticker onto the board.
   - A `war_tokens` row is inserted as `reserved` with the chosen colour. The
     two partial unique indexes decide the race; a violation on
     `war_tokens_colour_live` is `colour_taken`, one on
     `war_tokens_contract_live` is `already_entered`, and the client is told
     which.
   - An order is created with the war's current price copied in and
     `expires_at = now + 30 minutes`.
   - `payerPubkey` is stored when the wallet is connected.
   - Returns the order, the receiving wallet, the USDC mint and the amount.

2. **Pay with wallet.** The client builds a USDC transfer to `PAYMENT_WALLET`
   for the exact amount, the wallet signs and sends it through our RPC proxy
   (§8), and the signature is posted back.

3. **`POST /api/orders/:id/confirm`** — `{ signature }`. Rate-limited with
   bidoor's verification limiter. `verifyPayment` must find: the USDC mint, our
   wallet credited, an amount at least the order's price, a confirmed and
   non-failed transaction, and a block time inside the order's window plus the
   clock-skew allowance. Then, and this is the part bidoor does not have:

   > When the order carries a `payer_pubkey`, the transaction's fee payer or
   > one of the debited USDC owners must equal it.

   Without that check, a fixed price plus signature-only binding means anyone
   watching the chain can take a stranger's transfer and claim it against their
   own order — first call to `/confirm` wins the `consumed_signatures` race and
   the person who actually paid gets nothing. `verifyPayment` already returns
   `SenderInfo`, so the check costs one comparison.

   On success, inside one transaction: insert `payments`, mark the order
   `paid`, flip the `war_tokens` row to `active`. Overpayment is recorded and
   accepted.

4. **Paste-a-signature fallback.** Collapsed by default. The order has no
   `payer_pubkey`, so the sender check cannot apply and first-to-claim inside
   the window is the rule. The rules page says so plainly.

5. **Late confirmation.** A reservation that expires is `released`, freeing its
   colour. If the payment then arrives, we try to flip the same row back to
   `active`; the unique index rejects it if the colour was taken meanwhile, and
   the client is offered the remaining free colours. If the war is full or
   ended, the payment is filed in `unmatched_payments` and the payer is pointed
   at `SUPPORT_CONTACT` — a real inbox, because reuniting a stray payment is
   manual work done from `/admin`.

There are no automatic refunds. The rules say what happens when we cancel a
war, and it is an operator sending USDC back by hand.

## 6. Canvas API

Three endpoints, no websockets.

**`GET /api/canvas?war=<slug>`** — the full state as
`application/octet-stream`: one byte per pixel, `width * height` bytes, value =
palette slot, `0` = unpainted. 40,000 bytes for a 200×200 war, a few KB once
the platform gzips it. The current sequence number rides in `X-Canvas-Seq`
alongside `X-Canvas-Width` and `X-Canvas-Height`. Cached
`public, s-maxage=2, stale-while-revalidate=8`.

For an ended war this reads `war_snapshots` and is cached for a year: an
archived board cannot change, so serving it from `pixels` would be a query
nobody needs to run twice.

> This replaces the string of palette indices in the original brief. A byte
> array needs no charset decision, is half the size before compression, and
> arrives as the `Uint8Array` the renderer wants.

**`GET /api/diff?war=<slug>&since=<seq>`** — `{ seq, changes: [[idx, slot], …] }`,
everything after `since` in sequence order. When `since` is further behind than
`DIFF_MAX_CHANGES` (8,000) the response is `{ resync: true, seq }` and the
client refetches the canvas — cheaper for both sides than shipping a quarter of
the board as JSON. Cached `public, s-maxage=1, stale-while-revalidate=2`.

**`POST /api/paint`** — `{ warSlug, x, y, tokenId }`. In one transaction:

1. Load the war. If it is not `live`, or `now() >= ends_at`, close it lazily
   (§9) and answer `409 war_ended`.
2. Reject if the painter key, IP hash or subnet is banned. Resolve `tokenId`
   within the war and require it to be `active`: a token id from another war,
   or one still `reserved` and therefore unpaid, must not be paintable, and the
   check belongs in the transaction rather than in the client's good manners.
3. Bounds-check `x` and `y` against the war's own width and height.
4. Take the cooldowns. Each is a conditional upsert that only succeeds if
   enough time has passed:

   ```sql
   INSERT INTO paint_cooldowns AS c (war_id, key_type, key, last_painted_at, window_start, window_count)
   VALUES ($1,$2,$3, now(), now(), 1)
   ON CONFLICT (war_id, key_type, key) DO UPDATE
     SET last_painted_at = now(),
         window_start    = CASE WHEN c.window_start < now() - $5::interval THEN now() ELSE c.window_start END,
         window_count    = CASE WHEN c.window_start < now() - $5::interval THEN 1 ELSE c.window_count + 1 END
     WHERE c.last_painted_at <= now() - $4::interval
   RETURNING last_painted_at;
   ```

   No row returned means the cooldown is still running; the transaction rolls
   back and the caller gets `429` with the remaining seconds. Keys are always
   taken in the order painter, ip, subnet, so concurrent paints cannot deadlock
   against each other.

   The `subnet` key is gated on a **count**, not an interval — its `WHERE`
   clause is `c.window_start < now() - $window OR c.window_count < $cap`
   instead. A carrier pool hands out fresh addresses but not fresh prefixes, so
   the prefix is where rotation actually shows up; the cap is set well above
   what a household or an office would generate, because blocking a real
   community is a worse failure than admitting a determined attacker.
   `window_start` and `window_count` are only meaningful for this key type.
5. `UPDATE wars SET last_seq = last_seq + 1 RETURNING last_seq`. This serialises
   paints per war, which at a few per second is free, and buys a **gapless,
   totally ordered** sequence. A `BIGSERIAL` would not: sequence values are
   handed out before commit, so a client polling `since` can step over a row
   that committed late and lose a pixel silently.
6. Upsert `pixels`, append to `pixel_events`, adjust `token_pixel_counts` for
   both the old and new owner.

Responds `{ seq, idx, colourSlot, cooldownUntil }`.

**`GET /api/session`** — issues the painter cookie (§7) and returns
`{ cooldownUntil }` so a returning visitor sees the correct timer before doing
anything.

**`GET /api/leaderboard?war=<slug>`** — `token_pixel_counts` joined to
`war_tokens`, ordered by `owned`. Cached one second.

**`GET /api/pixel?war=<slug>&x=&y=`** — position, owning token, and when it was
painted. **Never the painter.** We have no accounts and `painter_key` is a
salted hash; exposing anything derived from it is a deanonymisation vector for
no product gain. The interesting author here is the token, and that is public
already.

If per-request database load ever becomes the constraint before CDN caching
does, the next step is a per-instance ring buffer of recent `pixel_events`.
Correctness is unaffected because the sequence is gapless. Not built now.

## 7. Anti-abuse

Painting is free, so nothing about money limits it. Three layers, none of them
individually sufficient, which is the honest description.

**Painter identity.** On first visit, `GET /api/session` sets `pw_painter`, an
HttpOnly, Secure, SameSite=Lax cookie holding `<random 16 bytes>.<HMAC>` signed
with `PAINTER_COOKIE_SECRET`. The server stores only a salted SHA-256 of the
random half, so a database leak cannot mint valid cookies. An unsigned or
malformed cookie is replaced, not trusted.

**Cooldown on the stricter of two keys.** Every paint takes both the painter
cooldown and the IP cooldown. Clearing the cookie leaves the IP; changing IP
leaves the cookie; defeating both per pixel is the cost we are imposing.

**Subnet burst cap.** A window count per `/24` (IPv4) and `/64` (IPv6), because
a phone rotating through a carrier's pool gets a fresh address but not a fresh
prefix.

**Bans.** By painter key, IP hash or subnet, with an optional expiry. Checked
on every paint.

**Turnstile hook, not integrated.** `verifyHumanCheck()` exists as a seam and
returns success whenever `TURNSTILE_SECRET` is unset, which it is. No script
tag, no CSP change, no client work. It is where the check goes when a war is
visibly botted.

This is weaker than what rplace.live (passkey plus captcha) and wplace.live
(Google account) run in production, and the trade is deliberate: an entry-fee
product cannot put a signup wall in front of its free half. The recorded
upgrade path is a passkey — free, no email, device-bound — not accounts.

## 8. The Solana RPC proxy

The wallet adapter has to reach an RPC node from the browser. Publishing
`NEXT_PUBLIC_SOLANA_RPC_URL` hands a paid provider key to anyone who opens dev
tools, and widening `connect-src` past `'self'` weakens the CSP for every page.

`POST /api/rpc` forwards a strict whitelist and nothing else:

| Method | Why the client needs it |
| --- | --- |
| `getLatestBlockhash` | Every transaction needs a recent blockhash |
| `getAccountInfo` | Check whether the payer's USDC token account exists |
| `getTokenAccountsByOwner` | Find that account |
| `getMinimumBalanceForRentExemption` | Only if the destination token account must be created |
| `sendTransaction` | Submit the signed transfer |
| `getSignatureStatuses` | Show "confirming…" before we verify server-side |

Anything else is rejected without being forwarded. Requests are rate-limited by
IP hash and the body size is capped. The provider key stays in
`SOLANA_RPC_URL`, server-side, and the CSP keeps `connect-src 'self'`.

Mobile deep-link wallets and Solana Mobile Wallet Adapter are out of scope for
v1: Phantom's and Solflare's in-app browsers inject a provider and work, and
everyone else has the paste-a-signature fallback. Recorded as a known gap.

## 9. Lifecycle and closing

`draft → scheduled → live → ended`, plus `cancelled` for an operator's
reschedule.

Both transitions are automatic, and both are idempotent. A `scheduled` war
whose `starts_at` has passed becomes `live` on the same two triggers that close
a `live` one — an operator does not have to be awake at the start time.

Two things drive them:

- **The reconcile cron**, hourly via GitHub Actions, the same workflow bidoor
  uses because Vercel Cron cannot send an authentication header.
- **Lazy evaluation on read.** Any request touching a war whose `ends_at` has
  passed closes it inline. GitHub's scheduler is best-effort and can run late;
  a war that ended eleven minutes ago must not still be accepting paint.

Closing, in one transaction, guarded by `UPDATE wars SET status='ended' WHERE
id=$1 AND status='live'` so only one caller does the work:

1. Recount `token_pixel_counts` from `pixels`.
2. Build the canvas byte array and the ranking; insert `war_snapshots` with
   `ON CONFLICT DO NOTHING`.
3. Stamp `ended_at`.

After that, `/api/paint` answers `409` for that war and the client renders the
frozen state — its own screen with its own copy, not a paint button that has
quietly stopped working.

The reconcile endpoint also expires stale reservations and orders, applies
payments that verified while DexScreener was unreachable, and nulls
`painter_key` and `ip_hash` past `IP_HASH_RETENTION_DAYS`.

## 10. Admin

Bidoor's console, extended. Shared secret in `ADMIN_TOKEN` / `ADMIN_TOKENS`,
revocable session cookie, lockout on repeated failures, every action in the
append-only audit log. Destructive actions require `ADMIN_STEP_UP_SECRET` when
it is set.

Day one:

- Create and schedule a war: title, slug, start, end, entry price, cooldown.
- Edit price and cooldown of a war that has not started.
- End a war early, or extend it.
- **Clear a rectangle** — sets the region to unpainted with one `pixel_events`
  entry per cleared pixel, so clients converge through the normal diff instead
  of being told to resync. The sequence range is allocated in a single
  `UPDATE wars SET last_seq = last_seq + $n RETURNING last_seq`, not one
  increment per pixel; a large clear will still exceed `DIFF_MAX_CHANGES` and
  push clients into a resync, which is correct and cheaper than the alternative.
- **Ban** a painter key, IP hash or subnet, with an optional expiry.
- **Remove a token** from a war, with a reason. Its pixels are cleared in the
  same transaction and its colour is retired for the rest of the war (§3).
- Review content reports and act on them.
- The unmatched-payments console, inherited: apply a stray payment to an order,
  behind step-up.

## 11. The client

**Renderer.** A single `<canvas>` and `ImageData`. 40,000 pixels is four orders
of magnitude below where Canvas2D struggles, so the WebGL machinery the
reference implementations need for a 2000×2000 board would be cost without
benefit. `imageSmoothingEnabled = false`, integer scaling, device-pixel-ratio
aware.

Two arrays are held: the base fetched from `/api/canvas`, and an overlay of
everything `/api/diff` has returned since, with a sentinel for "unchanged".
Compositing the two on redraw means a live pixel never rewrites the base.

**Polling.** `/api/diff` every 1.5 s, paused when the tab is hidden and resumed
with a single catch-up call. `resync: true` refetches the canvas.

**Viewport.** Wheel zoom toward the cursor, drag to pan, two-finger pinch on
touch. A pointer-up only paints if total movement stayed under a threshold —
without it every pan on a phone ends in an accidental pixel, which is the
single most valuable detail in the reference reading.

**Painting.** Pick a token from the rail (each entry: colour chip, logo,
ticker, current pixel count), tap a pixel, confirm. Number keys `1`–`9` and
then letters select tokens directly. The cooldown renders **inside the paint
button** — the button is the timer: `MM:SS` above a second, milliseconds in the
final second, then back to its label. The client predicts its own cooldown on
paint and reconciles with `cooldownUntil` from the response.

**HUD.** Coordinates and zoom at the top centre, `(x, y) 4.0x`. Time remaining
in the war, prominently. A live leaderboard rail that collapses on mobile.

**Template overlay** *(scope addition, cuttable)*. Load a local image, position
it on the grid, set its opacity, paint through it. Nothing is uploaded and
nothing is stored — it is a `<canvas>` drawn over another `<canvas>`. Both
reference implementations ship one because it is how a community actually
executes a design instead of arguing about coordinates in a group chat.

**Pixel inspection.** Tap-and-hold, or a desktop hover with the info toggle on:
position, owning token, and when it was painted.

**Report** *(scope addition, cuttable)*. Drag a rectangle, give a reason, send.
It names a region, not a person.

## 12. Pages and copy

All copy in English.

| Route | What |
| --- | --- |
| `/` | The live war: canvas, token rail, paint button, leaderboard, countdown |
| `/join` | Entry: chain and contract, colour picker, price, connect wallet |
| `/join/[orderId]` | Payment panel; pay-with-wallet primary, paste-signature collapsed |
| `/wars` | Archive |
| `/wars/[slug]` | An ended war: frozen canvas, final ranking, share image |
| `/rules` | Rules and moderation |
| `/admin` | Console |
| `/og/[slug]` | Share image for a war |

The rules page is a table of rule → consequence rather than prose, which is the
one structural thing worth taking from wplace: a reader can find their own case
in it. It covers what the entry fee buys, that painting is free and rate
limited, that overpainting is the game while targeted harassment is not, that
we clear content that would get the site taken down, that there are no
automatic refunds, and how a stray payment gets reunited with its order.

Every line of copy is ours. The reference file quotes rplace.live and
wplace.live so we can see how they say it; none of it is reused.

## 13. Security headers

bidoor's `next.config.ts`, with `img-src` still allowing only DexScreener's CDN
and `connect-src` still `'self'` — which the RPC proxy is what makes possible.
`/admin` and `/api` stay `no-store` and `noindex`. The one honest weakening,
`script-src 'unsafe-inline'` for Next's bootstrap, is inherited and recorded
rather than papered over.

## 14. Configuration

Required in production, no defaults, server refuses to start without them:
`DATABASE_URL`, `PAYMENT_WALLET`, `RATE_LIMIT_SALT`, `PAINTER_COOKIE_SECRET`,
`ADMIN_TOKEN` (or `ADMIN_TOKENS`), `SUPPORT_CONTACT`, `SOLANA_RPC_URL`.

Optional: `SITE_URL` (defaults to `https://pixelwar.fun`),
`ADMIN_STEP_UP_SECRET`, `IP_HASH_RETENTION_DAYS` (30), `TRUSTED_PROXY_HOPS`
(1), `PAINT_SUBNET_BURST` and `PAINT_SUBNET_WINDOW_SECONDS`,
`DIFF_MAX_CHANGES` (8000), `TURNSTILE_SECRET` (unset; the hook is inert).

Must not be set in production: `ALLOW_UNTRUSTED_CLIENT_IP`, `LOAD_DEMO_SEED`.

Entry price and duration are deliberately **not** here. They live on the war
row and are set by an operator.

## 15. Testing

vitest against a real Postgres, with `TEST_DATABASE_URL` required to differ
from `DATABASE_URL` and the suite refusing to start otherwise — bidoor's rule,
inherited, because the suite truncates tables.

Test-driven, and these are the cases that decide whether the product works:

- **Sequence.** Concurrent paints produce a gapless order; a client polling
  `since` across a concurrent burst loses no pixel.
- **Cooldown.** Two simultaneous paints from one painter: exactly one wins.
  Cookie cleared but same IP: still blocked. New IP, same cookie: still
  blocked. Subnet cap trips on burst.
- **Colour and contract races.** Two orders for the same colour, and two for the
  same token, each resolve to exactly one reservation with the right error on
  the other.
- **Payment.** Wrong mint, wrong destination, underpayment, unconfirmed,
  failed, replayed signature, and a signature from a wallet that is not the
  order's `payer_pubkey` — every one rejected, and overpayment accepted.
- **Late confirmation** after expiry, both when the colour is still free and
  when it is not.
- **Closing** is idempotent under concurrent lazy closes, and paint after
  `ends_at` is refused even when the cron has not run.
- **Retention** nulls painter keys and IP hashes without deleting pixels.

## 16. Deployment

Vercel plus Neon, mirroring bidoor's `DEPLOY.md`: production build check,
environment variables split into required/recommended/optional/must-not-be-set,
migrations run before the first deploy, a smoke test that ends with a real
payment on a throwaway war, and the reconcile secret matching between the
GitHub repository and the Vercel environment.

## 17. Deferred

EVM chains and entry by burn; card payments; accounts; passkeys as the
anti-sybil upgrade; timelapse and replay, which `pixel_events` already
supports; alliances between tokens; an NFT or an X bot for results; tiered or
auctioned colour pricing; larger canvases and simultaneous wars; seasons with a
historical ranking; Solana Mobile Wallet Adapter and deep-link wallets; sound.

## 18. File layout

```
migrations/          001_initial.sql, …
scripts/             migrate.mts, seed a demo war
src/app/
  api/               session, canvas, diff, paint, pixel, leaderboard,
                     orders, orders/[id]/confirm, rpc, report, reconcile,
                     admin/*
  join/, wars/, rules/, admin/, og/
src/components/      Canvas, Viewport, TokenRail, PaintButton, Leaderboard,
                     TemplateOverlay, PixelInspector, WalletButton
src/lib/
  canvas/            encode, diff, snapshot
  paint/             cooldowns, painter identity, bans
  payments/          solana, config, orders, reconcile, limits
  wars/              lifecycle, palette
  admin.ts, chains.ts, db.ts, dexscreener.ts, addresses.ts, …
```

`src/lib/canvas`, `src/lib/paint` and `src/lib/wars` are separate because each
answers one question — what the board looks like, whether this person may
paint, and what state the war is in — and each is testable without the other
two.

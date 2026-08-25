# Batch B — Payments and Entry Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A community can put its token into a war by paying a USDC entry with their wallet, and the token appears on the board only once the money is verified on chain.

**Architecture:** An order reserves a colour before any money moves, so the thing being bought exists before it is paid for. The browser builds and signs a USDC transfer through a server-side RPC proxy, posts the signature back, and the server verifies it against the chain — reading token-balance deltas rather than instruction shape, and requiring the payer to be the wallet the order was opened with. Every guarantee is a database constraint: one colour per war, one token per war, one payment per signature.

**Tech Stack:** Next 16.3.2, React 19.2.8, `pg`, Neon Postgres, `@solana/web3.js` v1 on the server, `@solana/wallet-adapter-*` in the browser, vitest 4.

**Spec:** [`docs/superpowers/specs/2026-08-24-pixelwar-design.md`](../specs/2026-08-24-pixelwar-design.md) — §5 (entry and payment), §8 (the RPC proxy), §3 (orders and payments tables).

## Global Constraints

- **Every string in the repo is English** — code, comments, commits, docs, UI copy. No Spanish.
- **The author is CryptoSandler, and nobody else.** This repo is public. No other name, handle, email or machine username in any file or commit. `git config` is already correct — do not override it, and **do not add a `Co-Authored-By` trailer**.
- **Never print a connection string, a private key, or a seed phrase.** Not in output, not in a report, not in a commit. Do not modify `.env.local`.
- **This project holds no private key, does no signing, and has no withdrawal path.** It only ever receives. Any task that seems to need a key is a task you have misread — stop and say so.
- **The server-side verifier stays on `@solana/web3.js` v1.** It is inherited, audited code. Do not migrate it to `@solana/kit`; the vendored `solana-dev` skill will suggest otherwise and that suggestion is declined for this file. Kit applies to new browser code only.
- **No ORM.** Parameterised `pg` queries only; never string-interpolate a value into SQL.
- **This is Next 16, not the Next in your training data.** Read the guides under `node_modules/next/dist/docs/` before writing a route handler or a component.
- **The database is Neon**: branch `production` (`DATABASE_URL`), branch `tests` (`TEST_DATABASE_URL`). **One suite at a time per branch** — every test truncates every table, and two suites against one branch deadlock on that truncate, surfacing as failures in whatever test happened to be running.
- **TDD.** Test first, watch it fail, implement minimally, watch it pass, commit. Commit each task separately; a task that dies uncommitted is a task redone.
- **Any test that touches the database gets its own `{ timeout: 20_000 }`, from the moment you write it.** The database is remote and a round trip costs roughly 200ms, so a test that creates a war, a token and runs two transactions is a dozen trips and lives against the 5-second default. Three tests in Batch A were found sitting at that ceiling, failing perhaps one run in four, and each was called a flake before somebody measured. Do not raise the suite default instead: that would take hang detection away from every pure test to accommodate the slow ones. Annotate the slow test, not the suite.
- **Never background the test suite.** Run `npm test` in the foreground and wait the three minutes. Three agents in this project stalled waiting on a suite they had backgrounded, and two of them lost uncommitted work when they died.
- **The suite does not cover the browser.** Batch A shipped three defects invisible to `tsc`, ESLint, `next build` and every test. Anything in `src/components/` or `src/hooks/` is unverified until someone has driven it and looked at a screenshot.

---

## Two decisions, already made

**The order carries a Solana Pay reference key.** A unique, unguessable public
key goes on the transfer as a read-only account. It is a third binding beside
the signature and the payer's pubkey, and it fixes what neither can: a payer who
signs and closes the tab never tells us the signature, so the money arrives and
no order hears about it. With a reference, a reconcile pass asks the chain
`getSignaturesForAddress(reference)` and settles it unaided.

The server generates a keypair, keeps **only the public key**, and discards the
secret unread. Nothing signs with it. This project holds no private key and
that does not change here.

It does not replace the payer binding: the reference says which order a payment
was for, the payer pubkey says who was allowed to pay it. Task 11 is the
recovery pass.

**The RPC provider is the public mainnet endpoint, read from `SOLANA_RPC_URL`.**
The same as the sibling project — which is to say, no dedicated provider. It is
heavily rate limited, and the proxy in Task 8 puts every payer's transaction
traffic through it, so this will need replacing before any war with real volume.
The variable exists so that is a configuration change and not a code change.
Do not hardcode an endpoint anywhere, and do not add a provider SDK.

## File Structure

```
migrations/002_orders_and_payments.sql   entry_orders, payments, consumed_signatures,
                                         unmatched_payments, verification_attempts

src/lib/payments/config.ts     USDC mint and decimals, the receiving wallet, RPC settings
src/lib/payments/solana.ts     verifyPayment — balance deltas, sender identification
src/lib/payments/orders.ts     create, read, expire; the colour reservation lives here
src/lib/payments/settle.ts     applying a verified payment: order paid, token active
src/lib/payments/limits.ts     verification attempt limits (extends Batch A's paint limits)

src/lib/tokens/chains.ts       the eight chains and their DexScreener identifiers
src/lib/tokens/addresses.ts    per-family address validation
src/lib/tokens/dexscreener.ts  canonical metadata, and the existence check
src/lib/tokens/links.ts        link normalisation

src/app/api/orders/route.ts               POST — reserve a colour, open an order
src/app/api/orders/[id]/route.ts          GET  — order status, for polling
src/app/api/orders/[id]/confirm/route.ts  POST — verify a signature on chain
src/app/api/rpc/route.ts                  POST — whitelisted Solana RPC proxy

src/app/join/page.tsx          chain, contract, colour
src/app/join/[orderId]/page.tsx            payment panel
src/components/WalletProvider.tsx          wallet-adapter context
src/components/PayWithWallet.tsx           build, sign, send, confirm
src/components/PasteSignature.tsx          the collapsed fallback
src/components/ColourPicker.tsx            free colours only
```

`src/lib/tokens/` is separate from `src/lib/payments/` because they answer different questions — what is this token, versus did this money arrive — and Batch D's admin console needs the first without the second.

---

### Task 1: Payment configuration

**Files:**
- Create: `src/lib/payments/config.ts`
- Test: `src/lib/payments/__tests__/config.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `USDC_MINT: string`, `USDC_DECIMALS: 6`, `PAYMENT_WINDOW_MINUTES: 30`, `LATE_CONFIRM_GRACE_MINUTES: 10` (see below), `BLOCKTIME_SKEW_SECONDS: 120`, `RPC_COMMITMENT: "confirmed"`, `RPC_MAX_ATTEMPTS`, `RPC_BACKOFF_MS`, `RPC_BACKOFF_MAX_MS`, `VERIFY_LIMITS`, `solanaRpcUrls(): string[]`, `paymentWallet(): { ok: true; address: string } | { ok: false; reason: string }`, `usdToBaseUnits(amountUsd: number): bigint`, `formatUsdc(baseUnits: bigint): string`, `supportContact(): string | null`.

- [ ] **Step 1: Read the source before copying it**

```bash
sed -n '1,120p' ~/proyectos/outbid-tokens/src/lib/payments/config.ts
```

Carry across the USDC constants, the RPC settings, `solanaRpcUrls`, `paymentWallet`, `usdToBaseUnits`, `formatUsdc`, `supportContact` and `VERIFY_LIMITS`, with their comments intact. **Do not carry** `FRACTION_MIN`, `FRACTION_MAX`, `FRACTION_UNIT_BASE`, `paymentBaseUnits` or `RATE_LIMITS` — those implement bidoor's unique-amount matching, which this product replaces with signature-plus-pubkey binding, and dead payment code is worse than none.

**What `LATE_CONFIRM_GRACE_MINUTES` means**, because Task 7 must not have to
guess: a reservation frees its colour the moment it expires — that is settled in
§5 and does not change. This constant governs only whether a `/confirm` arriving
after expiry still *tries* to take the colour back. Inside
`PAYMENT_WINDOW_MINUTES + LATE_CONFIRM_GRACE_MINUTES` of the order's creation, a
verified payment attempts the flip to `active` and is offered the remaining
colours if its own was taken. Past that, it goes straight to
`unmatched_payments` for an operator, because somebody who surfaces forty
minutes later is in a conversation with support, not in a checkout.

Batch A's `src/lib/config.ts` already holds `rateLimitSalt`, `trustedProxyHops`, `trustedPlatformHeader` and `allowUntrustedClientIp`. Do not duplicate them here; import them if you need them.

- [ ] **Step 2: Write the failing test**

```ts
import { beforeEach, describe, expect, it } from "vitest";
import { USDC_DECIMALS, USDC_MINT, formatUsdc, paymentWallet, usdToBaseUnits } from "../config";

describe("USDC amounts", () => {
  it("converts whole dollars to base units at six decimals", () => {
    expect(usdToBaseUnits(1)).toBe(1_000_000n);
    expect(usdToBaseUnits(99)).toBe(99_000_000n);
  });

  it("refuses an amount it cannot represent exactly", () => {
    // Entry prices are whole dollars. A fractional amount here means a caller
    // is inventing a price, and rounding it silently would take the wrong sum.
    expect(() => usdToBaseUnits(1.005)).toThrow();
    expect(() => usdToBaseUnits(-1)).toThrow();
    expect(() => usdToBaseUnits(-0)).toThrow();
    expect(() => usdToBaseUnits(Number.NaN)).toThrow();
    expect(() => usdToBaseUnits(Number.POSITIVE_INFINITY)).toThrow();
  });

  it("refuses an amount too large for a JS number to hold exactly", () => {
    // The guard must be Number.isSafeInteger, not Number.isInteger. Past 2^53
    // a float no longer has a neighbour: 2**60 and 2**60 + 1 are the SAME
    // value, so two different intended amounts arrive as one and neither the
    // caller nor we can tell which was meant. Refusing is the only honest
    // answer a money function has there.
    expect(() => usdToBaseUnits(2 ** 60)).toThrow();
    expect(() => usdToBaseUnits(Number.MAX_SAFE_INTEGER + 2)).toThrow();
    expect(usdToBaseUnits(Number.MAX_SAFE_INTEGER - 1)).toBeTypeOf("bigint");
  });

  it("round-trips through formatUsdc", () => {
    expect(formatUsdc(usdToBaseUnits(25))).toBe("25.00");
  });

  it("pins the mint and the decimals", () => {
    // Getting either wrong means verifying a payment in the wrong asset.
    expect(USDC_MINT).toBe("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");
    expect(USDC_DECIMALS).toBe(6);
  });
});

describe("paymentWallet", () => {
  beforeEach(() => {
    delete process.env.PAYMENT_WALLET;
  });

  it("refuses to take payments when no wallet is configured", () => {
    // A fallback here would mean a misconfigured deploy quietly collects
    // payments to somebody else's address.
    expect(paymentWallet().ok).toBe(false);
  });

  it("rejects a value that is not a Solana address", () => {
    process.env.PAYMENT_WALLET = "not-an-address";
    expect(paymentWallet().ok).toBe(false);
  });

  it("accepts a well-formed address", () => {
    process.env.PAYMENT_WALLET = "7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU";
    expect(paymentWallet()).toMatchObject({ ok: true });
  });
});
```

Restore `PAYMENT_WALLET` in an `afterEach` — the suite is single-fork and a variable one file deletes another inherits.

- [ ] **Step 3: Run it, watch it fail, implement, run it again, commit**

`npx vitest run src/lib/payments/__tests__/config.test.ts`, then `npm run lint` and `npm run build`.

```bash
git add src/lib/payments && git commit -m "Add payment configuration

The unique-amount machinery from the sibling project is deliberately left
behind: the binding here is the signature and the payer's key, and dead
payment code is worse than none."
```

---

### Task 2: The on-chain verifier

**Files:**
- Create: `src/lib/payments/solana.ts`
- Test: `src/lib/payments/__tests__/verifier.test.ts`

**Interfaces:**
- Consumes: Task 1's config.
- Produces: `type PaymentFailure`, `type SenderInfo = { feePayer: string | null; debited: { owner: string; amountBaseUnits: string }[] }`, `type VerifyResult`, `type SolanaTransaction`, `type TransactionFetcher = (signature: string) => Promise<SolanaTransaction>`, `verifyPayment(params): Promise<VerifyResult>`.

**No network in the tests.** `verifyPayment` takes an injectable `TransactionFetcher`; every test hands it a fabricated transaction.

- [ ] **Step 1: Carry the verifier across**

```bash
cp ~/proyectos/outbid-tokens/src/lib/payments/solana.ts src/lib/payments/solana.ts
```

Read it fully before changing a line. It is written against **token-balance deltas rather than instruction shape** — a transfer can arrive as `transfer`, `transferChecked`, through a CPI, or bundled with other instructions, and the delta on our account is the same in every case and cannot be faked by instruction shape. That property is the reason this file is being copied rather than rewritten. Keep every comment.

- [ ] **Step 2: Make the two changes this product needs**

**(a) Overpayment is accepted.** bidoor returns `overpaid` as a failure because it matched payments by exact amount. Here the price is fixed and the binding is the signature, so more money is not a mismatch — record what arrived and apply it. Remove `overpaid` from `PaymentFailure` and accept any amount at or above the expected one.

**(b) The payer must be the wallet the order was opened with.** Add an optional
`expectedPayer?: string` parameter. When present, the transaction's fee payer or
one of the debited USDC owners must equal it; otherwise fail with a new
`wrong_payer` reason.

**Present means present, not truthy.** Gate on
`params.expectedPayer !== undefined && params.expectedPayer !== null`, never on
the value being truthy. An empty string is falsy, so a truthiness check turns a
caller who passed a blank payer into a caller who asked for no binding at all —
and the function answers `ok: true` for a transaction some stranger paid. If the
field was supplied, enforce it: a blank or malformed value can never equal a
real address, so enforcing fails closed as `wrong_payer`, which is the answer
that costs nobody anything.

**Check the payer before the amount.** When both are wrong, report
`wrong_payer`. Somebody told they underpaid will send more money — from the same
wallet that will be rejected again. The amount is a problem a payer can fix; the
binding is not, and the one they cannot fix has to be the one they hear about.
The transaction and its amount are public to anyone holding the signature, so
saying which check failed leaks nothing a block explorer would not.

Comment (b) with why it exists:

```ts
/**
 * When the order was opened from a connected wallet, only that wallet can pay
 * it.
 *
 * Without this, a fixed price plus signature-only binding means anyone
 * watching the chain can take a stranger's transfer and claim it against their
 * own order — first call to /confirm wins the consumed_signatures race, and
 * the person who actually paid gets nothing. The paste-a-signature fallback
 * has no connected wallet and therefore no expected payer; that path is
 * first-to-claim inside the order's window, and the rules page says so.
 */
```

- [ ] **Step 3: Write the failing tests**

Fabricate transactions rather than fetching them. Cover, each with a comment saying what it protects:

```ts
it("accepts a transfer that credits our wallet with at least the price", ...)
it("accepts an overpayment and reports what actually arrived", ...)
it("rejects a transfer of a different mint", ...)          // wrong asset
it("rejects a transfer to a different destination", ...)   // somebody else's wallet
it("rejects an underpayment", ...)
it("rejects a transaction that failed on chain", ...)
it("rejects a transaction that is not yet confirmed", ...)
it("rejects a block time before the window opens", ...)
it("rejects a block time after the window closes", ...)   // the late edge
it("accepts a block time exactly on each edge of the window", ...)
it("names the sender when a real transfer did not match", ...)  // so support can reunite it
it("rejects a payer that is not the wallet the order was opened with", ...)
it("allows any payer when the order has no expected payer", ...) // the paste fallback
it("does not treat a blank expected payer as no binding at all", ...) // "" and "   "
it("checks the payer before the amount when both are wrong", ...)
it("sees a transfer made through a CPI", ...)              // the reason we read deltas
```

- [ ] **Step 4: Run, implement, run, commit**

---

### Task 3: Orders and payments schema

**Files:**
- Create: `migrations/002_orders_and_payments.sql`
- Test: `src/lib/payments/__tests__/schema.test.ts`

**Interfaces:** Produces the tables §3 of the spec specifies: `entry_orders`, `payments`, `consumed_signatures`, `unmatched_payments`, `verification_attempts`.

- [ ] **Step 1: Write the migration**

Follow §3 exactly. The constraints that carry the guarantees:

```sql
-- One payment per signature, globally. This single constraint is what makes a
-- signature single-use across the whole system; everything else about replay
-- protection is commentary on it.
CREATE TABLE payments (
  id                TEXT PRIMARY KEY,
  signature         TEXT        NOT NULL UNIQUE,
  order_id          TEXT        NOT NULL REFERENCES entry_orders (id),
  amount_base_units TEXT        NOT NULL,
  payer             TEXT,
  verified_at       TIMESTAMPTZ NOT NULL
);
CREATE UNIQUE INDEX payments_order_unique ON payments (order_id);
```

`amount_base_units` is TEXT because it is a u64 and does not fit a JS number safely — the same reason `wars.last_seq` is read through one conversion point.

`entry_orders` carries `reference_pubkey TEXT NOT NULL UNIQUE` — unique because
it is what a payment is looked up by, and a collision would attach one payment
to two orders.

`consumed_signatures` records every signature ever offered, with its outcome, so
a signature that failed verification cannot be retried against a different
order.

- [ ] **Step 2: Apply and assert the constraints hold**

`npm run db:up`, then tests that prove each constraint by violating it: two payments with one signature, two payments for one order, an order referencing a missing war token.

---

### Task 4: Colour reservation

**Files:**
- Create: `src/lib/payments/orders.ts`
- Test: `src/lib/payments/__tests__/orders.test.ts`

**Interfaces:**
- Produces: `createOrder(input): Promise<CreateOrderResult>`, `orderById(id)`, `expireStaleOrders(): Promise<number>`, `freeColours(warId): Promise<number[]>`.
- `CreateOrderResult` is `{ ok: true; order: Order }` or `{ ok: false; reason: "colour_taken" | "already_entered" | "war_full" | "war_closed" }`.

**Which war statuses may be bought into.** `live` and `scheduled` yes — entry
opens before a war starts and stays open while it runs. `draft`, `cancelled` and
`ended` no, all reported as `war_closed`. A draft is an operator's unpublished
work with no page a payer could even see it on; taking money for a war that may
never run is how you end up owing refunds.

**Colour slots are not capacity.** A war with five seats may hold slots 3, 9,
14, 20 and 24. The palette is a fixed twenty-four identities and `max_tokens`
caps how many are handed out, not which. Do not constrain a slot to
`1..max_tokens`.

**This is the subtle task of the batch.** The four `war_tokens` statuses are not interchangeable and the partial unique indexes from migration 001 encode the difference:

- `reserved` — holds a colour, nobody has paid.
- `active` — paid and painting.
- `released` — a reservation that expired unpaid. **Frees its colour**: nothing was ever painted in it, so reissuing cannot mislead anyone.
- `removed` — an operator pulled a token that had been `active`. Its colour is **retired for the rest of the war**, because reissuing a colour that already has pixels on the board hands one community's territory to another.

Both indexes are `WHERE status <> 'released'`, which is why `released` is the only status that frees anything.

- [ ] **Step 1: Write the failing tests — these are the specification**

```ts
it("reserves a colour and opens an order for it", ...)
it("refuses a colour another live reservation holds", ...)            // colour_taken
it("refuses a colour an active token holds", ...)                     // colour_taken
it("refuses a token already entered in this war", ...)                // already_entered
it("allows the same token in a different war", ...)
it("frees the colour when an unpaid reservation expires", ...)        // released
it("keeps a removed token's colour retired for the rest of the war", ...)
it("lets exactly one of two simultaneous orders take a colour", ...)  // the index decides
it("lets exactly one of two simultaneous orders take a token", ...)
it("refuses once every colour is spoken for", ...)                    // war_full
it("seats no more than max_tokens when two orders race the last seat", ...)
it("reports war_full rather than colour_taken when both are true", ...)
it("refuses an order on a war that has ended", ...)                   // war_closed
it("refuses an order on a war that is still a draft", ...)            // war_closed
it("accepts an order on a scheduled war", ...)   // entry opens before the war
it("accepts an order while the war is running", ...)  // entry stays open mid-war
```

The concurrency tests must use `Promise.all` and assert exactly one success.

**Colour and contract are arbitrated by the unique indexes. Capacity is not, and
that is the trap.** `max_tokens` has no index behind it, so a `count(*) < max`
condition — whether in a preceding SELECT or inside the INSERT's own WHERE — is
not atomic under READ COMMITTED: two callers taking different colours each see
the same pre-race count, both pass, and the war seats one token more than it
allows. Take `SELECT ... FROM wars WHERE id = $1 FOR UPDATE` at the top of the
transaction, the same way the paint path in Batch A serialises on that row to
allocate its sequence. Order creation happens at most twenty-four times per war;
serialising it costs nothing and is the only thing that makes the count mean
what it says.

Resolve the colour and contract races with the unique index and translate the
violation by constraint name — `isUniqueViolation` and `violatedConstraint` from
`src/lib/db.ts` exist for this. Do not pre-check with a SELECT and then insert:
two callers would both read "free" and both proceed.

- [ ] **Step 2: Implement, run, commit**

---

### Task 5: Token identity

**Files:**
- Create: `src/lib/tokens/chains.ts`, `addresses.ts`, `links.ts`, `dexscreener.ts`
- Test: `src/lib/tokens/__tests__/` for each

**Interfaces:** `CHAINS`, `getChain`, `isChainId`, `dexscreenerTokenUrl`; `validateAddress(chain, value)`; `resolveToken(chain, contract): Promise<MetadataResult>`.

- [ ] **Step 1: Carry the four modules across from the sibling project**

```bash
for f in chains addresses links dexscreener; do
  cp ~/proyectos/outbid-tokens/src/lib/$f.ts src/lib/tokens/$f.ts
done
```

**Tasks 1 and 2 left you two duplicates to remove.** Task 1 wrote a private
Solana base58 checker in `src/lib/payments/config.ts`; Task 2 wrote another in
`src/lib/payments/solana.ts`. They have already drifted — Task 2's rejects empty
input and Task 1's does not — which is the whole argument against duplication,
demonstrated inside one batch. Delete both, put one base58 decoder somewhere
shared, and have `paymentWallet` call `validateAddress("solana", …)`. Two independent address validators in one
codebase will drift, and the one that drifts is the one nobody remembers exists.

Read each. Keep the comments — particularly the one on `pickPair`, which explains that DexScreener returns pairs and the token you asked about is not always the pair's base token, so reading `baseToken` blindly lists the wrong token's name and logo.

Metadata comes from DexScreener and not from whoever is paying: that is what stops a buyer owning an entry's identity, and it doubles as the existence check — an address no DEX has ever seen cannot be listed.

- [ ] **Step 2: Tests with a stubbed fetch, no network**

Cover: the base-token confusion above; an address that does not exist; a chain whose DexScreener id differs from its name (`bnb` → `bsc`, `hyperliquid` → `hyperevm`), because getting that wrong makes every lookup on the chain silently return nothing; per-family address validation for each of the eight chains; and an image URL from a host that is not DexScreener's CDN being dropped.

---

### Task 6: POST /api/orders

**Files:**
- Create: `src/app/api/orders/route.ts`, `src/app/api/orders/[id]/route.ts`
- Test: `src/app/api/__tests__/orders.test.ts`

**Interfaces:**
- `POST /api/orders` — `{ warSlug, chainId, contract, colourSlot, payerPubkey? }` → 201 `{ orderId, amountUsd, payTo, mint, expiresAt }`; 409 with a `reason` for `colour_taken` / `already_entered` / `war_full` / `war_closed`; 400 for a malformed address or unknown chain; 404 for an unknown token or war.
- `GET /api/orders/[id]` → `{ status, amountUsd, expiresAt, paidAt, tokenTicker, colourSlot }`.

**The reference key is generated here.** `Keypair.generate()`, keep
`.publicKey.toBase58()`, let the secret go out of scope unread — write a comment
saying so, because the next reader will wonder where the secret went and deserves
to know it was never wanted. Store it on the order and return it, so the client
can attach it to the transfer.

- [ ] **Step 1: Failing tests**

Validate the address before spending a DexScreener call. Rate-limit order creation per `ip_hash` using Batch A's `identify()` — the same fail-closed rule applies, and an order reserves a colour, which is a scarce resource an unlimited caller could exhaust.

Cover: the happy path; each refusal with its status and reason; a payer pubkey that is not a valid Solana address rejected; an order for a war that has not started (allowed — entry opens before the war does); the response never including anything server-side.

---

### Task 7: POST /api/orders/:id/confirm

**Files:**
- Create: `src/lib/payments/settle.ts`, `src/app/api/orders/[id]/confirm/route.ts`
- Test: `src/lib/payments/__tests__/settle.test.ts`, `src/app/api/__tests__/confirm.test.ts`

**Interfaces:** `settlePayment({ order, signature, verified }): Promise<SettleResult>` — one transaction: insert `payments`, mark the order `paid`, flip `war_tokens` to `active`.

- [ ] **Step 1: Failing tests, hardest first**

```ts
it("marks the order paid and the token active", ...)
it("refuses a signature already consumed by another order", ...)   // the replay
it("refuses a second confirm of the same order", ...)              // payments_order_unique
it("refuses when the payer is not the order's wallet", ...)
it("accepts an overpayment and records what arrived", ...)
it("rate limits repeated verification attempts", ...)              // RPC quota is money
it("files a payment that arrived after the war filled up", ...)    // unmatched_payments
it("re-takes the same colour on a late confirm when it is still free", ...)
it("offers the remaining colours when the colour was taken meanwhile", ...)
it("leaves nothing behind when verification fails", ...)
```

Late confirmation is the case that decides whether somebody loses money. A reservation that expires is `released`, freeing its colour. If the payment then arrives, try to flip that same row back to `active`; the unique index rejects it if the colour was taken meanwhile, and the client is offered the remaining free colours. If the war is full or ended, file the payment in `unmatched_payments` with the sender, and point the payer at `SUPPORT_CONTACT` — reuniting a stray payment is manual work done from `/admin`, and it needs a real inbox.

**Never** let a verification failure leave a half-applied order. One transaction, or nothing.

---

### Task 8: The RPC proxy

**Files:**
- Create: `src/app/api/rpc/route.ts`
- Test: `src/app/api/__tests__/rpc.test.ts`

**Why it exists:** the wallet adapter must reach an RPC node from the browser. Publishing `NEXT_PUBLIC_SOLANA_RPC_URL` hands a paid provider key to anyone who opens dev tools, and widening `connect-src` past `'self'` weakens the CSP for every page. The proxy keeps the key server-side and the CSP unchanged.

- [ ] **Step 1: Failing tests**

The whitelist, and nothing else:

| Method | Why the client needs it |
| --- | --- |
| `getLatestBlockhash` | every transaction needs a recent blockhash |
| `getAccountInfo` | does the payer's USDC account exist |
| `getTokenAccountsByOwner` | find it |
| `getMinimumBalanceForRentExemption` | only if a token account must be created |
| `sendTransaction` | submit the signed transfer |
| `getSignatureStatuses` | show "confirming…" before the server verifies |

```ts
it("forwards a whitelisted method", ...)
it("rejects a method that is not whitelisted, without forwarding it", ...)
it("rejects a batch containing a non-whitelisted method", ...)   // arrays are requests too
it("caps the body size", ...)
it("rate limits by ip_hash and fails closed without an address", ...)
it("never returns the upstream URL or key in an error", ...)
it("does not forward client headers upstream", ...)
```

The "without forwarding it" assertions matter: assert the upstream stub was **not called**, not merely that the response was an error. A proxy that forwards and then discards is not a whitelist.

---

### Task 9: Wallet checkout

**Files:**
- Create: `src/components/WalletProvider.tsx`, `PayWithWallet.tsx`, `ColourPicker.tsx`, `src/app/join/page.tsx`, `src/app/join/[orderId]/page.tsx`
- Modify: `src/app/layout.tsx` (mount the provider)

```bash
npm install @solana/web3.js @solana/wallet-adapter-base @solana/wallet-adapter-react \
  @solana/wallet-adapter-react-ui @solana/wallet-adapter-wallets
```

Phantom, Solflare and Backpack. Point the adapter's connection at `/api/rpc`, never at a public endpoint.

The flow: pick chain and contract → resolve the token and show what was found,
so nobody pays for a typo → pick a colour from the free ones → connect wallet →
**show recipient, amount, token and network before signing** → sign → post the
signature to `/confirm` → poll `GET /api/orders/[id]` until `paid`.

The transfer instruction carries the order's `reference_pubkey` as an extra
account: not a signer, not writable. It changes nothing about what the transfer
does; it is a marker the chain will let us search by later.

- [ ] **Verify in a browser, and say what you could not verify.** A wallet signature needs a wallet; if you cannot drive one, take the flow as far as the unsigned transaction and report exactly where you stopped. Do not claim a payment path works because it compiles.

---

### Task 10: The paste-signature fallback

**Files:**
- Create: `src/components/PasteSignature.tsx`
- Modify: `src/app/join/[orderId]/page.tsx`

Collapsed by default, under a disclosure. It exists for a payer whose wallet cannot reach the browser — a mobile deep link, a hardware wallet, an exchange withdrawal.

An order paid this way has no connected wallet and therefore no expected payer, so it is first-to-claim inside the order's window. **Say so in the UI**, next to the input, not only in the rules.

- [ ] Validate the signature's shape client-side before spending a verification attempt on it.

---

---

### Task 11: Recovering a payment nobody claimed

**Files:**
- Create: `src/lib/payments/recover.ts`
- Test: `src/lib/payments/__tests__/recover.test.ts`

**Interfaces:** `recoverUnclaimedOrders(fetcher?): Promise<{ recovered: string[]; filed: string[] }>`.

This is the payoff for the reference key. For every order that expired unpaid,
ask the chain for signatures touching its reference, and settle the first one
that verifies. The payer never came back; the money is theirs either way.

- [ ] **Step 1: Failing tests, with an injected signature fetcher — no network**

```ts
it("settles an expired order whose payment did arrive", ...)
it("re-takes the colour when it is still free", ...)
it("files the payment for support when the colour was taken", ...)
it("files it when the war filled up or ended", ...)
it("leaves an order alone when the chain knows nothing about its reference", ...)
it("is idempotent — a second pass settles nothing twice", ...)
it("ignores a signature already consumed by another order", ...)
```

- [ ] **Step 2: Implement over `settlePayment` from Task 7**

Reuse it rather than writing a second settlement path: two ways to mark an order
paid is two places for them to disagree. This pass finds the signature; Task 7's
function decides what it means.

Called lazily today and by the reconcile cron in Batch E. It runs against the
real RPC, so cap how many orders it examines per pass and say so in a comment —
the public endpoint's rate limit is shared with every payer's checkout.

---

## Batch B is done when

- `npm test` is green, `npm run lint` clean, `npm run build` clean.
- A token can be taken from contract address to a colour on the board with a real devnet USDC payment.
- A signature cannot be spent twice, on any order.
- An expired reservation frees its colour; a removed token does not.
- The browser never talks to anything but our own origin.
- A payer who signs and closes the tab still gets their token on the board.

## Deliberately not in this batch

Closing a war and its snapshot (Batch C); the admin console (D); the reconcile cron, the rules page, content reports and the template overlay (E). EVM chains, entry by burn and card payments stay out of v1 entirely.

## Self-review against the spec

**Covered:** §5 end to end — reservation, order, wallet checkout, verification with payer binding, overpayment, late confirmation, unmatched payments; §8 the proxy and its whitelist; §3's order and payment tables; the four `war_tokens` statuses and what each does to a colour.

**Not covered, and named:** the reconcile *cron* that will call Task 11 on a
schedule (Batch E — the function and its tests are here, the timer is not);
refunds, which are an operator sending USDC by hand and are documented on the
rules page in Batch E.

**Type consistency:** `Order`, `CreateOrderResult` and `SettleResult` are produced in Tasks 4 and 7 and consumed unchanged in 6, 7, 9 and 10. `colourSlot` is camelCase in TypeScript and `colour_slot` in SQL throughout, converted only in row mappers — the rule Batch A settled.

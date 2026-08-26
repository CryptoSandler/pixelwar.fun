# Admin orphans — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development.

**Goal:** Give the unmatched-payment queue a human. A stray payment is
currently filed to `unmatched_payments` and the payer is told to write to
support — but nobody can see that table without a psql prompt.

**Architecture:** Adapt bidoor's hardened admin module rather than writing one;
add the first admin surface; then two small corrections that came out of the
Batch B report.

**Spec:** `docs/superpowers/specs/2026-08-24-pixelwar-design.md`

## Global Constraints

- Next.js 16.3.2 App Router. Route handlers are plain `Request` functions.
  **Read the relevant guide under `node_modules/next/dist/docs/` before writing
  route or page code** — this version differs from recollection.
- Parameterised SQL only, via `pg`. No ORM.
- `@solana/web3.js` v1. No `@solana/kit`.
- Every database test carries a per-test `{ timeout: 20_000 }`. Never raise the
  suite default.
- All copy English. The string "Fede" appears nowhere, including commits.
- Colours from `src/lib/wars/chrome.ts`; no hard-coded hex. Fonts only via
  `next/font/google`. Radius 0 per DESIGN.md §4.
- Neither `opacity` nor `filter` may alter the colour of text or of a control
  that carries text (DESIGN.md §9).
- **Every new module names its caller** (CLAUDE.md). A brief that creates a
  function, job or route says who invokes it, and the test that proves it
  drives the caller, not the callee.
- Never edit an applied migration; add the next number (CLAUDE.md).

---

### Task 1: Admin access, adapted from bidoor

**Files:**
- Create: `src/lib/admin.ts`, `src/app/api/admin/session/route.ts`,
  `migrations/005_admin.sql`
- Test: `src/lib/__tests__/admin.test.ts`

**Copy and adapt, do not rewrite.** The source is
`~/proyectos/outbid-tokens/src/lib/admin.ts` (297 lines),
`src/app/api/admin/session/route.ts`, `src/lib/__tests__/admin.test.ts`, and
the tables in `migrations/002_admin_hardening.sql`. That module already answers
three security findings and the value is in its having been read line by line:

- the cookie carries a **revocable session id**, never the master secret, so a
  leaked cookie is a session to revoke rather than an env var to rotate;
- failed logins are counted and locked out, because an endpoint answering "is
  this the token?" without limit is a brute-force oracle;
- the token comparison is over fixed-length SHA-256 digests, so it cannot leak
  the secret's length through an early return, and every configured token is
  checked even after a match so timing does not reveal which.

Adapt: the cookie name becomes `pixelwar_admin`; use this project's `query`,
`queryOne`, `execute` and `transaction` from `src/lib/db.ts`; use this
project's `ip_hash` helper rather than bidoor's; migration is `005`.

`ADMIN_TOKEN` is the single-operator form and is what this project uses.
Document it in `.env.example` in the style of the entries already there,
including that it is required for `/admin` to exist at all and that an unset
token means the surface refuses every request rather than opening.

### Task 2: /admin/orphans

**Files:**
- Create: `src/app/admin/orphans/page.tsx`, `src/app/api/admin/orphans/route.ts`,
  `src/app/api/admin/orphans/[id]/assign/route.ts`
- Test: `src/app/api/__tests__/admin-orphans.test.ts`

The list: signature, amount, date, and the reason it was filed. Newest first.
Show the amount as USDC, not base units.

Assignment: pick an order for a filed payment and settle it against that order.
**This is the only path in the project that moves money on a human's say-so**,
so it must reuse `settlePayment`'s guarantees rather than write its own
UPDATEs — the same colour exclusivity, the same signature claiming, the same
one-transaction settlement a payer would get. If `settlePayment` cannot be
reused as-is, say why in the report before doing anything else.

Guard every route with the admin session. An unauthenticated request gets the
same answer as a wrong token.

### Task 3: Archive always, recover in window; and the cron's JSON check

**Files:**
- Modify: `src/lib/payments/recover.ts`, `.github/workflows/reconcile.yml`,
  `.env.example`, `scripts/seed-war.mts`

**Archive always, recover only in the window.** Today a payment discovered more
than `RECOVERY_MAX_AGE_DAYS` after its order expired is never recovered *and
never filed* — it leaves no record anywhere. Split the two: the age bound stops
an old payment from taking a colour, and stops nothing else. Past the bound it
is still found and still filed to `unmatched_payments`, where `/admin/orphans`
can now see it.

**The cron must not accept a bare 200.** `.github/workflows/reconcile.yml`
currently treats any 2xx as success, so a deployment that answers 200 with
something other than the counts JSON passes silently. Fail the run unless the
body parses and carries both counts.

**Record three decisions** that are currently written down nowhere:
`SUPPORT_CONTACT=support@pixelwar.fun` in `.env.example`; entry price $25 and
cooldown 60 seconds as the seed defaults in `scripts/seed-war.mts`, each with
a one-line comment saying it is a decision and not a placeholder.

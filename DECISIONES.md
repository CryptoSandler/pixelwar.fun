# Decisiones

Code this project deliberately deleted, and why. A file for the removals that
would otherwise look like an accident to whoever finds the gap later — a
deleted module leaves no comment behind, so the reason has to live somewhere.

---

## 2026-09-01 — The race bar as a track beside the row

**Removed:** `.score-track` and `.score-fill` from `src/app/globals.css`, and
the `<span className="score-track">` element from
`src/components/Scoreboard.tsx`.

**The race itself was NOT removed** — it is the row's background now, a
rectangle proportional to the leader in the token's own flag colour. This
entry is about the eight-pixel track that used to sit in its own grid column,
because that element is gone and its CSS with it.

**Why it went:** the momentum number needed a place and the row had no width
for a fourth thing. **Measured rather than judged by eye:** the row is 252px
inside a 280px sidebar; with identity, momentum, track and share the grid
resolved to `120px 40px 2px 52px` — the track was a two-pixel sliver and the
ticker had already been pushed into its own ellipsis ("HEEB..."), which
DESIGN.md §9 forbids outright, since the ticker is what carries token identity
when colour cannot.

**Why a background rather than dropping the race:** it costs no width at all,
and it reads dominance down the whole sidebar better than a column of stubby
tracks did. The first attempt did drop it — on the argument that the track was
`aria-hidden` and, in its own comment, "a second rendering of the number
already announced beside it". The owner overturned that, and was right: the
duplication is the point of a scoreboard, which exists to be scanned rather
than read.

**What the change cost, and it is a new class of risk.** Every row is now a
surface that did not exist when the invariants were written: the panel with
one of twenty-four saturated colours composited over it, carrying the ticker.
That is the same shape as the first brass — a colour chosen against one test
and failing an unrelated second one. So the tint is capped by a MEASURED
ceiling, `ROW_FILL_ALPHA` in `chrome.ts`: at 14% the worst case is #000000 at
8.42:1 against a body floor of 7, and at 22% it goes under. `chrome.test.ts`
asserts it for all twenty-four colours and for the chip outline, and asserts
the reason is still written beside the number.

## 2026-08-31 — The USDC payment path

**Removed:** `verifyPayment` and its helpers (`sumFor`, `senderOf`,
`reportsAttributedUsdc`) from `src/lib/payments/solana.ts`;
`buildPaymentTransaction`, the `transferChecked` and associated-account
instruction encoders, and the SPL program constants from
`src/lib/payments/transfer.ts`; `USDC_MINT`, `USDC_DECIMALS`,
`usdToBaseUnits` and `formatUsdc` from `src/lib/payments/config.ts`; and
`src/lib/payments/__tests__/verifier.test.ts` entire, plus the SPL half of
`transfer.test.ts`.

**Why it went:** the owner decided admission is charged in SOL, like the
painter's registration. After that change nothing called any of it — checked
by grep for call sites rather than assumed, and the type checker agreed.

**Why it was deleted rather than left dormant.** Three reasons, in order of
how much they cost:

1. **Dead payment code is a live liability.** It is hardened, it is
   convincing, and it is exactly the thing somebody reaches for when they add
   "just one" USDC surface later — reintroducing a second denomination on the
   shared receiving wallet, which is the one thing
   `docs/operations.md` says must not happen quietly.
2. **It was already drifting.** The registration verifier had to be written
   beside it rather than through it, because native balances are positional
   and token balances are not. Two verifiers, one live, is a comment that ages
   into a lie about which one is authoritative.
3. **It is not lost.** It is in the history, it was green when it was
   removed, and this entry names it precisely enough to restore.

**What was deliberately KEPT out of it:**

- `PaymentFailure`, `VerifyResult` and `SenderInfo` — the vocabulary
  `settlePayment` reads. `verifySolPayment` returns the same union on purpose,
  so settlement stays denomination-agnostic rather than being forked.
- `defaultFetchTransaction` — the retry, rotation, timeout and
  error-swallowing discipline both verifiers need, worth having exactly once.
- `wrong_token` as a failure reason. Unreachable on a native transfer, kept
  because it is stored on rows.
- The reference-account machinery, which is the whole recovery story and is
  now attached to a `SystemProgram.transfer` instead of a `transferChecked`.

**What replaced it:** `verifySolPayment` in
`src/lib/payments/sol-transfer.ts`, beside the registration verifier it shares
its balance reader with.

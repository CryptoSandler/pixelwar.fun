# Decisiones

Code this project deliberately deleted, and why. A file for the removals that
would otherwise look like an accident to whoever finds the gap later — a
deleted module leaves no comment behind, so the reason has to live somewhere.

---

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

# What Phantom says, and what it actually means

Three warnings account for nearly every "the site is broken" report on a
Solana money path. None of them means what the person reading it thinks, and
two of them are OUR fault rather than the wallet's. This is the order to
diagnose them in.

---

## 1. "This domain is new" / "first time interacting with this site"

**What it means:** Phantom has not seen this origin before. Nothing is wrong.

**What to do:** wait a week of real traffic, then submit the site through the
review form at `docs.phantom.com`. Not before — a brand-new domain with no
history is exactly the profile the warning exists to flag, and asking for
review on day one wastes the one request.

**What NOT to do:** do not change the flow, do not add reassurance copy to the
screen, and above all do not read this warning as the next one. They look
similar to a frightened person and they have nothing in common.

---

## 2. "This transaction may be malicious"

**THIS ONE IS ALMOST NEVER ABOUT THE DOMAIN, AND IT IS USUALLY OURS.**

**What it means:** the transaction Phantom was handed FAILED SIMULATION. The
wallet cannot tell "this would rob you" from "this would not succeed", so it
says the alarming one. The commonest cause by far is a payer who does not
hold enough SOL to cover the amount plus the network fee.

**So the order of investigation is: pre-flight first, domain last.**

1. Would this transaction simulate? `POST /api/preflight` answers exactly
   that, server-side, before the wallet is ever opened — balance against
   amount-plus-fee, then `simulateTransaction` with `sigVerify: false`.
2. Is the payer short of SOL? That is `insufficient_funds`, and the screen
   says so in a sentence naming the amount that fixes it.
3. Only if both are clean is it worth thinking about reputation.

**Why the pre-flight exists at all.** Without it, a payer who is fifty cents
short is told by their own wallet that this site may be trying to rob them.
They do not send a support message; they leave, and they tell people. A
sentence of ours costs one RPC call and prevents that entirely.

### The pre-flight here is FAIL-OPEN, and that is a decision

**If the pre-flight cannot run — the RPC node is down, the request times out,
the answer is unreadable — the payment proceeds and the wallet opens.** Only a
definite "no" (not enough funds, or a simulation the chain rejected) stops the
flow.

**Why.** The pre-flight is a courtesy, not a control: it exists to turn
Phantom's "may be malicious" into a sentence, and nothing about it protects
the product. Blocking on its absence would invent an outage out of our own
caution — a payer with a perfectly good balance, refused because OUR node was
unreachable, on a payment that would have gone through. And Phantom simulates
the transaction anyway: with our check skipped, the worst case is the
behaviour we had before this endpoint existed, which is exactly the failure
mode we are willing to fall back to.

**nftraffle chose the opposite and is also right.** There the pre-flight is
FAIL-CLOSED: no answer means no signature. The difference is what a wrong
guess costs on each side. There a failed transaction burns a mint slot and the
inventory is finite, so proceeding blind can cost somebody an allocation that
cannot be handed back; here a failed transaction costs the network fee and the
person tries again. Same mechanism, opposite default, because the consequence
of being wrong is not symmetric.

**Do not "harmonise" these two without re-reading that paragraph.** A divergence
that was decided reads exactly like a divergence that was forgotten, which is
why it is written down here.

**If this warning appears when the pre-flight passed**, something in the
transaction changed between the check and the signature — a stale blockhash, a
balance spent elsewhere in another tab. Re-run the flow before suspecting
anything deeper.

---

## 3. "Valid on mainnet" / the wallet says the network is wrong

**What it means:** the person's Phantom is in **testnet mode** (Settings →
Developer Settings). Their wallet is signing against devnet or testnet while
the transaction is built for mainnet.

**What to do:** ask them to turn testnet mode off. There is nothing to fix in
the application, and this is the one warning of the three that no server-side
check can prevent — the injected provider takes no `chain` argument, so the
wallet signs on whatever network its owner chose.

**What the application does instead**, because it cannot stop it:

- `paymentSafety` refuses to open a wallet when the deployment's cluster and
  the adapter's disagree, or when either is unknown.
- The money routes refuse server-side when the upstream RPC is not mainnet.
- Where the Wallet Standard feature is available, `sendOnMainnet` passes
  `chain: "solana:mainnet"` explicitly.

---

## The rehearsal, before every change to the money path

Written up in full in `operations.md` under "The dress rehearsal before every
money-path change". The short version, because it belongs beside these
warnings too:

**A real wallet, real SOL, on production, on a throwaway war, cleaned up
afterwards.** Connect → pay → paint → close the tab and come back → try to pay
twice. Server-side evidence after each step, and `unmatched_payments` empty at
the end.

A staging environment cannot produce these three warnings. Phantom's domain
reputation, its simulation and its network mode are all facts about the real
origin, the real chain and the real person's wallet — which is exactly why the
rehearsal is on production and with money that is actually spent.

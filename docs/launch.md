# The launch checklist

pixelwar.fun is **not launched**. Three independent mechanisms keep it out of
search indexes today — `src/app/robots.ts`, `metadata.robots` in
`src/app/layout.tsx`, and the `X-Robots-Tag` header in `next.config.ts` — and
`robots.ts` carries the three-step instruction for removing them.

**This file is the list of what has to be true BEFORE that instruction is
followed.** It exists because the instruction was the only thing written down:
`robots.ts` said exactly how to open the doors and nothing at all about when,
so "are we ready" had no answer anybody could check. A lever with no
preconditions beside it gets pulled on a feeling.

**Two columns, and the split is the point.** The left column is a condition:
something that is either true of this repository and this deployment or is
not, and that somebody can go and check. The right column is what the OWNER
has to do about it — because several of these cannot be discharged from
inside the repository at all, and pretending otherwise is how the biggest one
on this list stayed undone for the whole life of the project.

---

## The gate that has never been passed

| What has to be true | What the owner does |
| --- | --- |
| **The dress rehearsal has been run on PRODUCTION, with real money, end to end.** This is the one item on this page that nothing in the repository can do, nothing in the test suite covers, and no preview deployment can stand in for. It has never been done. | Run the five steps in [`operations.md`](operations.md), *"The dress rehearsal before every money-path change"*, in order, on production: connect, pay the admission through `/join`, pay the registration and paint, close the tab and come back, then **try to pay again and confirm it is REFUSED for the right reason**. Check the server-side evidence after each step — the order row, the `payments` row, the refusal reason, and that `unmatched_payments` is empty. End the rehearsal war and remove its pixels afterwards. |

**Why this is at the top rather than filed with the rest.** A preview proves
the code runs. It cannot prove that a real wallet, a real RPC provider, the
real receiving address and this deployment's own configuration agree with one
another — and that is the half that costs money when it is wrong. Every other
line on this page fails visibly. This one fails by taking somebody's SOL and
crediting it to nobody.

**The last step is the whole exercise, not a formality.** A second payment
that is accepted, or refused for the wrong reason, is a failed rehearsal.

---

## Configuration that must be set on the production deployment

| What has to be true | What the owner does |
| --- | --- |
| `PAYMENT_WALLET` is set and is the intended receiving address. There is deliberately no fallback: a default here would mean a misconfigured deploy quietly collects payments to somebody else's address. | Set it, and confirm `/join` renders a checkout rather than "Entries are not open yet" — which is what the screen says when this is missing. |
| `SOLANA_RPC_URL` points at mainnet and is a URL `classifyEndpoints` can name. A cluster it cannot classify answers `unknown`, which **blocks every signature** rather than guessing. | Set it, then load the payment screen and confirm the network it names is the one you mean. A disclosure that can be silently wrong is worse than none, because it is trusted. |
| `SITE_URL` is set to the public origin. Two things read it: the same-origin check on every write, and `metadataBase`, which is what makes a share card's `og:image` absolute. | Set it. Without it the card unfurls with no image — a failure that looks fine locally, because localhost resolves for the developer and for nobody else. |
| `SUPPORT_CONTACT` is set. Unset is honest about itself — the copy then says this deployment has no contact configured — but a deployment taking real money should have one. | Set it to an inbox a person reads. It is what every "your payment has been filed" message names, and `/rules` prints it. |
| `CRON_SECRET` is set and the reconcile cron in `vercel.json` is running. | Set it and confirm the daily run at 04:00 UTC is executing. The route fails closed when the secret is unset, which means a missing value looks like a cron that is simply never succeeding. |
| `REGISTRATION_FEE_SOL` is whatever the owner intends, including deliberately unset. | Decide it, or accept the documented default. Zero is a valid value and is the door: it turns registration into a wallet signature with no payment, in a variable, without a deploy. |

---

## The state of the database

| What has to be true | What the owner does |
| --- | --- |
| **No fixture or rehearsal war is in production.** Two wars titled "Fixture war" have already been found in this project's production database — created by a test run against the wrong connection string — and they were invisible until the home page started reading finished wars, at which point production's front page said "Result — Fixture war". | Run `SELECT id, slug, title, status FROM wars;` against production and confirm every row is a war you meant to create. The archive at `/wars` will list any of them that ended with pixels on the board. |
| Production is migrated to the same level as `main`. | `npm run db:migrate` against production, and confirm the applied versions match the files in `migrations/`. |
| The first war exists, made with `createWar` rather than an INSERT. | Create it from `/admin/wars` — title, slug, start, end, price, cooldown, board size, admission cap. Opening a war is itself part of the path being rehearsed, so it goes through the same function everything else does. A war is never live on creation: `advanceWar` owns that transition and turns it live at `starts_at`. |

---

## The product surfaces a first visitor meets

| What has to be true | What the owner does |
| --- | --- |
| ~~The spec and the README describe the money path that actually exists.~~ **Done 2026-09-02.** Both said the entry was USDC for a batch after the USDC checkout was deleted. | Nothing. Recorded here because it was a launch blocker: the README links the spec as *Design*, so it is the first document anybody reads, and it described a payment path the code does not have. |
| ~~A finished war has a permanent page and an image somebody can post.~~ **Done 2026-09-02** — `/wars`, `/wars/[slug]` and `/og/[slug]`, with `openGraph` and `twitter:card` on `/` and on each war. | Nothing. Recorded here because a product whose distribution is communities posting that they won had, until that batch, nothing for them to post. |
| ~~`/rules` exists and is reachable from the screens that ask for money.~~ **Done 2026-09-02.** | Nothing. It is linked from `/join`, the intermission, the archive and every result page. |
| The share card renders on the production deployment, not only locally. | Open `https://<origin>/og/<slug>` for a real war and look at the PNG. The two typefaces are read from disk at runtime and forced into the deployed function by `outputFileTracingIncludes` in `next.config.ts`; if that ever breaks, this route 500s in production and works everywhere else. |

---

## Pulling the lever

| What has to be true | What the owner does |
| --- | --- |
| All three noindex layers are removed **together**. Removing one or two leaves the site invisible while looking open, which is the worst of both. | In one commit: change `disallow` to `allow` in `src/app/robots.ts`, drop the `robots` block from `metadata` in `src/app/layout.tsx`, and drop the `X-Robots-Tag` entry from `next.config.ts`. |
| The site is actually crawlable afterwards. | Fetch `/robots.txt`, then fetch `/` and read the response HEADERS as well as the HTML — `X-Robots-Tag` is the layer that covers everything a `<meta>` tag cannot reach, and it is the one most easily left behind. Check a specific string you know is in the page at the same time, so an empty response cannot read as a clean result. |

---

## What is deliberately NOT on this list

**The four open decisions stay open, and none of them blocks a launch.** They
are the owner's, they are recorded where an operator reads them, and every one
of them has a mechanism underneath it that supports both answers — so none has
to be settled before the first war, and each is better settled after one:

- **Ban terms**: whether permanent bans should exist at all. `bans.expires_at`
  is nullable and the panel defaults to a fixed term.
- **Sworn holdings**: whether a wallet's holding should be re-checked after the
  oath. To be taken after the first real war, on evidence.
- **`PAINT_SIDES_LOCK_MINUTES`**: ships at 0 everywhere, and turning it up
  requires the countdown copy in the same batch.
- **The board-signal thresholds**: initial values, meant to be wrong, and
  nothing acts on the report.

See [`operations.md`](operations.md) for each. **Do not settle one of these by
writing a sentence into published copy** — a rules page that names a ban
duration has decided the ban question by publication, which is why `/rules`
says painting can be refused and stops there.

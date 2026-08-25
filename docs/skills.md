# Agent skills: what is installed, what is not, and why

A skill is a directory of Markdown that an agent with tools reads as
instructions. Installing one is closer to granting write access than to adding
a dependency: whatever the file says, the agent will try to do. So skills are
**vendored** here — cloned by hand, read in full, copied into `.claude/skills/`,
committed, and hashed — never installed from a registry at run time.

Verify the vendored copies against their recorded hashes:

```bash
node scripts/skills-lock.mjs verify
```

## The rules

1. **Verify authorship before anything else.** Org age, repo count, declared
   domain, licence. A plausible name is not authorship.
2. **Download from the repository by hand.** `git clone`, then read. No
   `npx skills add`, no `install.sh`, no installer that writes outside this
   repo. Upstream installers here defaulted to writing into `~/.agents/skills`
   and `~/.claude/skills` — outside the project, affecting every other
   project, invisible to this repo's git history.
3. **Audit before copying.** Read every file. Look for instructions that
   install software, add MCP servers, pipe remote scripts to a shell, or send
   data anywhere.
4. **An agent never adds an MCP server.** Skills that instruct one to are
   patched before install, and the patch is recorded below.
5. **Hash what was installed**, not what upstream published. If we modified a
   file, the lock file records the modification and hashes our copy.

## Installed

| Skill | Author | Authorship evidence | Licence | Version | Upstream commit |
| --- | --- | --- | --- | --- | --- |
| `solana-dev` | Solana Foundation | GitHub org `solana-foundation`, created 2019-12-10, 102 public repos, links solana.org and @SolanaFndn. **Not** domain-verified by GitHub — the corroboration is the org's age, size and outbound links, not a badge. | MIT | 2.4.0 | [`68ee828`](https://github.com/solana-foundation/solana-dev-skill/commit/68ee828a6c25af0d834d07559c3b4a7fc3343321) |

### What it is for here

Narrowly: the **frontend half** of the payment flow, and a second opinion on
the security of the whole of it.

- Wallet Standard connection, and building and signing the USDC transfer
  (`references/frontend.md`, `references/kit/react.md`).
- Checkout patterns (`references/payments.md`).
- Reviewing our flow against `references/security.md`.

**It is not a mandate to migrate anything.** The server-side verifier inherited
from bidoor is `@solana/web3.js` v1 and stays there. The skill is opinionated
about `@solana/kit` and will suggest otherwise; that suggestion is declined for
the verifier, which is audited code whose value is in having been read line by
line. Kit applies to new browser-side code only.

Large parts of the skill are irrelevant to this project and should not be
followed: Anchor and Pinocchio program development, Codama client generation,
Surfpool/LiteSVM/Mollusk, confidential transfers. pixelwar.fun deploys no
on-chain program. Those pages also contain `curl … | bash` installer lines for
Surfpool and the Anza CLI — a real hazard if an agent follows them, and the
reason this paragraph exists.

### Local modification

`SKILL.md` shipped a section headed **"Auto-install"**:

> Before starting any Solana task, check if the Solana MCP server is already
> available … If not available, install it using your host's MCP mechanism:
> `claude mcp add --transport http solana-mcp-server https://mcp.solana.com/mcp`

A skill that tells an agent to add an MCP server before doing anything else is
the exact thing rule 4 exists for, regardless of who publishes it or how benign
the server is. The section is replaced with a prohibition pointing back here.
Nothing else in the skill is changed, and the lock file hashes our copy.

## Discarded

| Candidate | Author | Licence | Why not |
| --- | --- | --- | --- |
| [`phantom/phantom-agent-kit`](https://github.com/phantom/phantom-agent-kit) | Phantom (GitHub org **is** domain-verified, phantom.app) | MIT | Every skill in it is built around Phantom Connect — embedded wallets and social login — which needs an `appId` from Phantom Portal. That is a Phantom-hosted account product, not the browser wallet flow we want. |
| `phantom-mcp` / `phantom-connect-sdk` (in that repo's `.mcp.json`) | Phantom | MIT | Two MCP servers, one requiring `PHANTOM_APP_ID`. Explicitly out of scope. |
| Any RPC-provider skill | — | — | Nothing to inherit yet. See below. |

### What the Phantom React skill actually showed

Reviewed as a checkout reference, per the brief. It adds nothing the Solana
Foundation skill does not cover, and its payment example is a worked list of
things our design already decided against:

| Phantom's `references/payments.md` | Our decision |
| --- | --- |
| `new Connection("https://api.mainnet-beta.solana.com")` in the component | The browser talks only to `/api/rpc`; the provider key stays server-side and `connect-src` stays `'self'` |
| SOL transfer via `SystemProgram.transfer` | We move USDC, an SPL token — a different instruction and a different failure surface |
| `await solana.signAndSendTransaction(tx)` then `setStatus("success")` | A sent signature is not a settled payment. Ours is not settled until the server has verified it on chain |
| `catch { setStatus("error") }` | Swallows every failure into one word. The payer needs to know whether they were rejected, underfunded, or already paid |

Worth having looked at. Not worth installing.

## Solana RPC provider

**bidoor does not use one.** `SOLANA_RPC_URL` is unset in its `.env.local`, and
`solanaRpcUrls()` falls back to `https://api.mainnet-beta.solana.com` — which
bidoor's own `.env.example` describes as "heavily rate limited and should be
replaced with a dedicated provider in production". So there is no provider skill
to inherit, and none is installed: vendoring a provider's skill before choosing
the provider would be picking one by accident.

This matters more for pixelwar than it did for bidoor. bidoor called an RPC only
when verifying a payment. pixelwar proxies the browser's transaction traffic
through `/api/rpc` for every payer, so the public endpoint's rate limit becomes
a checkout failure rather than a slow admin page.

The directory at [solana.com/skills](https://solana.com/skills) carries skills
from **Helius** (DAS API, enhanced transactions, webhooks) and **QuickNode**
(Solana RPC, Jupiter, Yellowstone gRPC). Nothing from Triton, Alchemy, Syndica
or Shyft. Pick a provider before Batch B and the matching skill gets the same
audit as this one.

## Firecrawl MCP

Reinstalled at **user scope**, so it is available in every project rather than
only in `outbid-tokens`:

```bash
claude mcp add --transport http -s user firecrawl https://mcp.firecrawl.dev/v2/mcp-oauth
```

It now sits in the top-level `mcpServers` of `~/.claude.json`.

**Yes, you have to authorise it again.** The URL ends in `/mcp-oauth`, and the
OAuth grant is held per server entry; the old entry was scoped to the
`outbid-tokens` project and the new one is a separate entry with no token
attached. Authorisation needs an interactive session — run `/mcp` in Claude
Code and complete the browser flow.

## Findings that change the product

Two things came out of reading `references/payments.md` and
`references/security.md` against our own payment design.

**1. Solana Pay's `reference` key is a third binding, and a better one for
recovery.** The skill's advice is to "attach a memo or a unique reference
account to correlate on-chain settlement with an order", then "verify settlement
server-side by finding the transaction via the `reference` key". Our spec binds
an order to a payment by signature plus payer pubkey, which works only when the
client comes back to tell us the signature. A unique, unguessable reference
pubkey added as a read-only account to the transfer would let the reconcile job
find a payment whose `confirm` call never arrived — the tab-closed case that
currently ends in `unmatched_payments` and a manual refund. Recorded against
Batch B in the spec; not built now.

**2. Everything else it warns about, we already do.** "Confirm settlement by
querying chain state, not by trusting client-side callbacks", "treat 'signature
received' as not-final; track confirmation", "protect against replay" — these
are the bidoor verifier's existing behaviour, and it is worth knowing that an
independent checklist arrives at the same shape. Its "never assume token program
variant; detect Token-2022 vs classic" does not apply: we pin the USDC mint, and
the verifier reads token-balance deltas rather than instruction shape, which is
correct for either program.

Its agent-safety section — "never request, generate, log, or store private keys,
seed phrases, or keypair file contents" — matches the constraint bidoor states
in its own `.env.example`: this project only ever receives, holds no private
key, does no signing, and has no withdrawal path.

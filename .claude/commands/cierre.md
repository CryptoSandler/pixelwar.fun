---
description: Close a batch — prove it works before it gets merged.
---

# Batch close

A batch is not closed because the work feels finished. It is closed when every claim
below has output sitting next to it.

Two rules govern this whole file:

- **Paste real output.** Never summarise it, never retype it from memory, never describe
  it ("tests pass"). The output is the evidence; a description of the output is not.
- **A step that cannot run is a blocked close, not a skipped step.** Say which step is
  blocked and why, and stop. Reporting a blocked close is a result. Reporting success
  without it is a lie.

## 1. What changed

```bash
git diff main...HEAD --stat
```

Three dots, not two. `main..HEAD` compares against wherever `main` is *now*, so anything
that landed on `main` after this branch started gets reported as ours. Three dots compares
against the merge base — the point this branch actually left from.

Read the file list before moving on. A file in that list you did not mean to touch is the
cheapest bug you will ever catch.

## 2. Prove it works

Run all three, in this order, and paste each one's full output.

```bash
npm test
npm run lint
npm run build
```

`npm test` needs `TEST_DATABASE_URL` set and the test database reachable — `vitest.env.ts`
asserts a sentinel marker before any test file is allowed to touch anything, so a missing
or wrong test database aborts the run rather than quietly hitting the wrong one. If it
aborts, that is a blocked close (see rule 2). Do not work around it by running a subset.

Paste the parts that are not about your change too. A pre-existing failure you inherited is
information the reader needs; hiding it makes the next batch debug it from scratch.

## 3. One line per claim

For every "this works" you are about to write, one line, with the evidence beside it:

| Claim | Evidence |
|---|---|
| e.g. Wallets with no legs are rejected | `pnl.test.ts` — 4 passing cases, output in §2 |

Rules for this table:

- A claim with no evidence column does not go in the table. It goes in §4.
- "The tests pass" is not a claim about the feature. Name what the feature now does.
- Evidence is a test name, a command's output, or a URL you actually loaded. Not a file
  path you edited, and not a description of the code you wrote — code is the thing being
  tested, so it cannot be its own evidence.

## 4. What did not make it

Explicit list, no euphemisms. Anything in scope at the start of the batch that is not in
the diff, plus anything you found along the way and left alone:

- what it was
- why it is not here (out of scope / blocked / deliberately deferred)
- whether anything in this batch depends on it

An empty section is a valid answer only if you can say "nothing was left out" and mean it.

## 5. Commit

```bash
git add <explicit paths>
```

By path, never `git add -A` and never `git add .`. Other sessions work in these
directories and the tree may hold changes that are not yours. Run `git status` first and
account for every file you are about to stage.

Commits are authored by `CryptoSandler` and carry **no trailers** — no `Co-Authored-By`,
no `Generated with`. Check before pushing:

```bash
git log main..HEAD --format='%h  %an  <%ae>'
git log main..HEAD --format='%(trailers)' | grep . && echo 'TRAILERS PRESENT — fix before pushing' || echo 'no trailers'
```

Every author line must read `CryptoSandler <294572464+CryptoSandler@users.noreply.github.com>`.
The `noreply` address is the point: a personal email in the log is a no-doxx leak that
survives in the public history. A wrong author or a present trailer is fixed with
`git commit --amend --reset-author --no-verify` (or `git rebase` for more than one commit)
*before* the push, never after.

## 6. Prove the push landed

```bash
git rev-parse HEAD
git ls-remote origin refs/heads/<this-branch>
```

Report **both** SHAs. They must be the same string. `git push` reporting success is not
proof the remote moved — `ls-remote` asks the remote what it actually has.

If they differ, the push did not land where you think it did. Say so; do not re-push and
hope.

## Closing report

The batch close is those six things, in order, in one message: the diff stat, the three
outputs, the claims table, what was left out, the author check, and the two SHAs.

---
description: Close a batch — prove it works before it gets merged.
---

# Batch close

A batch is not closed because the work feels finished. It is closed when every claim
below has output sitting next to it.

Five rules govern this whole file:

- **Paste real output.** Never summarise it, never retype it from memory, never describe
  it ("tests pass"). The output is the evidence; a description of the output is not.
- **A step that cannot run is a blocked close, not a skipped step.** Say which step is
  blocked and why, and stop. Reporting a blocked close is a result. Reporting success
  without it is a lie.
- **Evidence lands in `~/proyectos/evidencia/<repo>/<date>-<batch>/`, never in `/tmp` and
  never in a per-session scratchpad.** A close cites its evidence, and a citation into a
  directory the OS empties — or into a scratchpad addressable only by the session that is
  already over — is a citation nobody can follow. One subdirectory per repository, with a
  `README.md` naming what each artifact is. Build output and private keys are not evidence.
  `~/.claude/GATES.md` has the incident.
- **No pipe in a gate.** `npm test | tail -20` reports **`tail`'s** exit status, not the
  suite's, so a red run comes back `0` and any wrapper that reads the code announces a
  success. Measured 2026-09-01 in `kolscanhispano`: `npm test 2>&1 | tail -18` printed
  `Test Files  1 failed | 57 passed (58)` while the runner reported *completed (exit code
  0)*. The failure was caught by reading the summary; trusting the status would have merged
  it. Every gate is redirected, its status captured on the same line, and the log read
  afterwards — never `|`, never `| tee`, never `| grep`:

      cmd > "$EV/<name>.log" 2>&1; echo "EXIT: $?"

  `set -o pipefail` fixes the status too and is not the rule here: the redirect also
  produces the artifact the evidence rule above requires, so one habit satisfies both.
- **A check that decides something answers, or says it could not.** Never `2>/dev/null` on
  it and never `wc`, `grep` or `tail` after it — both turn a command that FAILED into a
  confident zero. Measured 2026-09-02 in `kolscanhispano`: `git log @{u}..HEAD 2>/dev/null
  | wc -l` printed `0` for a branch that had **no upstream at all**, was read as "nothing
  to push", and the push published a local working branch to a shared remote. Verify the
  command can answer first — `git rev-parse --abbrev-ref @{u}` — then ask it, unpiped, and
  report a failure as *I do not know* rather than as zero. `~/.claude/GATES.md` has the
  incident.

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
EV=~/proyectos/evidencia/pixelwar/$(date -u +%Y-%m-%d)-$(git branch --show-current); mkdir -p "$EV"

npm test      > "$EV/npm-test.log"  2>&1; echo "TEST  EXIT: $?"
npm run lint  > "$EV/npm-lint.log"  2>&1; echo "LINT  EXIT: $?"
npm run build > "$EV/npm-build.log" 2>&1; echo "BUILD EXIT: $?"
```

Read the logs after the three statuses, not through a pipe on the command itself — see the
fourth rule at the top of this file.

**`EV` is assigned ONCE, at the top of the close, and every command after it uses the
variable.** Never re-evaluate `date -u` later in the batch. Crossing midnight UTC mid-close
on 2026-09-01 in `milliondollarpage` sent a build and a suite into a directory dated the
next day that did not exist: both reported a non-zero exit, and the exit was the shell
failing to redirect rather than either tool failing. A close that re-derives its own
evidence path can report a failure it did not have, and can scatter one batch across two
directories.

`npm test` needs `TEST_DATABASE_URL` set and the test database reachable — `vitest.env.ts`
asserts a sentinel marker before any test file is allowed to touch anything, so a missing
or wrong test database aborts the run rather than quietly hitting the wrong one. If it
aborts, that is a blocked close (see rule 2). Do not work around it by running a subset.

Paste the parts that are not about your change too. A pre-existing failure you inherited is
information the reader needs; hiding it makes the next batch debug it from scratch.

## 3. Read the captures yourself

A batch that ran Playwright produced screenshots. **They are evidence for you, not a
deliverable for the owner.** Handing over a directory of PNGs moves the work of looking
onto the person who asked for the batch, and "the captures are in `test-results/`" is a
close that verified nothing.

Before writing the report, for **every** capture the run produced:

1. **Open it.** Actually open it — a file that exists is not a file that was looked at.
2. **Describe it in one line.** What is on the screen, in words. A capture you cannot
   describe is one you did not read.
3. **Contrast it against `DESIGN.md` and against the copy the page is supposed to say.**
   The document is open while you do it, per *"every verdict cites the written norm"*.

**Any deviation is a finding of this close**, and goes in §5 with everything else that did
not make it — whether or not a test went red over it. The reason a screenshot exists at all
is to catch what no assertion thought to check: a broken layout, a wrapped heading, English
copy on a Spanish surface, a placeholder that shipped.

**Captures are not offered as the owner's gate.** One exception, and only one: an
**aesthetic batch**, where what changed is how something looks and the owner's eye is the
acceptance criterion. Even there the gate is **the preview URL** — the real page, in their
browser, at their viewport — and never a directory of files.

## 4. One line per claim

For every "this works" you are about to write, one line, with the evidence beside it:

| Claim | Evidence |
|---|---|
| e.g. Wallets with no legs are rejected | `pnl.test.ts` — 4 passing cases, output in §2 |

Rules for this table:

- A claim with no evidence column does not go in the table. It goes in §5.
- "The tests pass" is not a claim about the feature. Name what the feature now does.
- Evidence is a test name, a command's output, or a URL you actually loaded. Not a file
  path you edited, and not a description of the code you wrote — code is the thing being
  tested, so it cannot be its own evidence.

## 5. What did not make it

Explicit list, no euphemisms. Anything in scope at the start of the batch that is not in
the diff, plus anything you found along the way and left alone:

- what it was
- why it is not here (out of scope / blocked / deliberately deferred)
- whether anything in this batch depends on it

An empty section is a valid answer only if you can say "nothing was left out" and mean it.

## 6. Commit

```bash
git status
git diff -- <each path you are about to stage>
git add <explicit paths>
```

By path, never `git add -A` and never `git add .`. Other sessions work in these
directories and the tree may hold changes that are not yours.

**Read the diff of every path you are about to stage, not just the list of paths.**
Restricting a commit to one file does not restrict it to your work: the file may already
hold somebody else's uncommitted change, and `git status` reports the filename identically
either way. If a path carries work that is not this batch's, **either the message declares
it or the hunk stays out** — `git add -p` leaves the rest in the tree for whoever wrote it.

Measured 2026-09-01: five repositories each took a one-file commit, `git status` was read
in every one, and four of them silently carried an unrelated section that had been sitting
uncommitted in every working tree. The commits were right about the path and wrong about
the contents. `~/.claude/GATES.md` has it.

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

## 7. Prove the push landed

```bash
git rev-parse HEAD
git ls-remote origin refs/heads/<this-branch>
```

Report **both** SHAs. They must be the same string. `git push` reporting success is not
proof the remote moved — `ls-remote` asks the remote what it actually has.

If they differ, the push did not land where you think it did. Say so; do not re-push and
hope.

## Closing report

The batch close is those seven things, in order, in one message: the diff stat, the three
outputs, what the captures showed, the claims table, what was left out, the author check,
and the two SHAs.

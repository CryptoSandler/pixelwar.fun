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

  **And the failure has to change control flow, not text.** Writing that precondition as
  `echo "up: $(git rev-parse --abbrev-ref @{u} 2>/dev/null || echo 'NONE — stopping')"` prints
  `NONE — stopping` and **does not stop**: inside `$( )` the `||` composes the *value*, not
  the flow. Measured 2026-09-02 while writing this very guard, in `outbid-tokens`; the push
  went ahead and was correct only by luck, because the check beside it used an explicit
  `origin/main`. The tell is the word "stopping" followed by more output.

      up=$(git rev-parse --abbrev-ref @{u} 2>/dev/null) || { echo "no upstream"; exit 1; }
      [ -n "$up" ] || { echo "no upstream"; exit 1; }

  **A repository with no upstream is configured on the spot**, not routed around:
  `git branch --set-upstream-to=origin/main main`, then verify it prints `origin/main`.
  Substituting an explicit ref forever leaves one repository where a documented check can
  never answer, which is the condition this rule exists to refuse.

**A shared file in ANOTHER repository is patched in a throwaway worktree, never in its
checkout.** `~/proyectos/<repo>` is somebody's working tree: it may hold their uncommitted
work, it is on whatever branch they are on, and a commit there lands on that branch.

```bash
W="$(mktemp -d)/<repo>-rules"
git -C ~/proyectos/<repo> worktree add "$W" main
# edit in "$W", read the diff, commit, push
git -C ~/proyectos/<repo> worktree remove "$W"
```

Measured 2026-09-01: a session patching shared rules committed `d1e91e0` into a checkout
another session was working in, on *that* session's branch. It became their `HEAD`, they had
not made it, and it broke `npm run build` on a branch whose author never ran the gates on it
— found when their own close failed for a reason that was not theirs.

`main` explicitly, not whatever `HEAD` is. Remove the worktree when done. **Every guard above
still applies inside it** — diff read per path, one commit per repository, `+0000` checked
before the push. A worktree changes where the work happens, not what the close owes.

If a foreign commit is already at the tip of your branch, it is not yours to rewrite: keep
it, fix what it broke in a commit of your own that says so, and tell whoever wrote it.

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

### A migration is applied to all three databases, in the same close

**A batch that adds a file to `migrations/` is not closed until every database this
repository can name reports it — test first, production last.**

**This repository's migrator has no `--preview` target, and a preview database exists**
(`PREVIEW_DATABASE_URL` is set, and the check reads it). So a divergence there has no
one-command fix here: it is applied by pointing `DATABASE_URL` at that branch for one run,
or by giving `migrate.mts` the third target the way `nftraffle` and `kolscanhispano` have
it. That is a gap in this repository, named rather than worked around. The suite cannot see this: it runs against
`TEST_DATABASE_URL`, and that is the one database the close is guaranteed to have
migrated. Every other one is invisible to every other gate.

    npm run db:migrate:test    > "$EV/migrate-test.log" 2>&1;    echo "EXIT: $?"
    npm run db:migrate         > "$EV/migrate-prod.log" 2>&1;    echo "EXIT: $?"

Then **ask each database what it holds**, rather than trusting that the commands ran:

    npx tsx scripts/schema-versions.mts > "$EV/schema-versions.log" 2>&1; echo "EXIT: $?"

It prints one line per database with its host and version, and exits non-zero when they
disagree, when one cannot be read, or when fewer than two are configured. A disagreement is
a blocked close, not a note in the report.

**Measured 2026-09-02 in `nftraffle`:** a green close shipped `007_listing_attempts` to the
test database only. Preview answered `500` on the new route's first request, and production
was found a further version behind, at `006`. `~/.claude/GATES.md` has the incident.

### The server runs on this repository's own port

**`pixelwar` is 3105** — `npm run dev` and `npm start` carry `-p 3105`, and any
rehearsal or end-to-end script defaults to it. The table for all six
repositories is in `~/.claude/GATES.md`; do not move a port without moving it
there.

**A run that reaches a server still asks which application answered.** Measured
2026-09-02 in `nftraffle`: a rehearsal on the old shared port got `404`s from a
different project that had taken it, after an earlier call in the same session
had been answered correctly. The port table makes that unlikely; an identity
check on a sentence only this application serves is what makes it detectable.

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

**The message goes in through a file, never through `-m` with a shell in it.** Backticks
are command substitution and `$word` is a variable, so `git commit -m` hands the message to
the shell before git ever sees it: the substitution runs, its output is kept, and what is
left becomes the commit. Nothing errors in a way anyone reads. Measured 2026-09-02 in
`drakes`, commit `8c71186`: ``No `system`: two themes`` was published as `No : two themes`,
with `command not found: system` printed above a wall of push output and skimmed as noise.
**The tell is a missing word in a message that is already pushed**, and by then the fix
costs a force-push over published history. The quotes on the delimiter are the point — an
unquoted `EOF` interpolates exactly the way `-m` does:

```bash
git commit -F - <<'EOF'
Subject line

Body with `backticks` and $variables, untouched.
EOF
```

`-m` is still fine for a short subject with no backtick, no `$` and no `!`.

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

**Every commit about to be published is stamped `+0000` — checked, not assumed.** The
habit (`TZ=UTC git commit`) is a thing to remember, and remembering is what it stopped
doing: four commits reached a shared `main` on 2026-09-02 stamped `-0300` from a session
that had the rule and did not apply it. Verify the upstream can answer first, then read the
dates **unpiped** — rule five:

```bash
git rev-parse --abbrev-ref @{u}                        # must name a branch, not fail
git log origin/<branch>..HEAD --format='%h %ai | %ci'  # read every line yourself
```

**Both dates, because git stamps two.** An author offset and a committer offset, and they
part company routinely — a rebase or an `--amend` rewrites one and leaves the other. A check
that reads only `%ad` passes a commit carrying local time in `%cd`.

If a line is not `+0000`, fix it **before** the push. One commit:

```bash
GIT_COMMITTER_DATE="@$(git log -1 --format=%ct) +0000" \
  git commit --amend --no-edit --date="@$(git log -1 --format=%at) +0000"
```

Several:

```bash
git rebase origin/<branch> --exec 'GIT_COMMITTER_DATE="@$(git log -1 --format=%ct) +0000" git commit --amend --no-edit --date="@$(git log -1 --format=%at) +0000"'
```

`@<epoch> +0000` and never a formatted date: the epoch *is* the instant, so this changes the
offset and moves nothing in time. Rehearsed on a scratch repository before being written
down — `+0900` and `-0300` both became `+0000` with the epoch unchanged.

**Never on a commit already published.** The window is exactly "local and unpushed"; past it
the offsets are history other people have fetched and the fix becomes a force-push. A branch
that arrives carrying published `-0300` is left alone and reported.

**And the rewrite goes in the report.** It is invisible afterwards, and the shas moved.

**A documentation commit does not spend a deployment.** Two defences, because the third one
turned out not to exist:

- **The project skips the build itself. This is the defence.** Every project carries an
  Ignored Build Step:

      git diff --quiet HEAD^ HEAD -- ":(exclude)docs" ":(exclude).claude" ":(exclude,glob)*.md"

  Exit 0 skips. A missing `HEAD^` builds, which is the safe direction. `,glob` is
  load-bearing: without it `*` matches `/` and the pattern would exclude every `.md` at every
  depth instead of the repository's root-level ones.

  **The excluded set is aligned with `.vercelignore`, where the repository has one.** A
  directory that is never uploaded cannot change what is served, so it belongs in the
  exclusions — `drakes` therefore also excludes `scripts` and `migrations`. **A repository
  with no `.vercelignore` uploads everything**, so nothing extra is provably unserved and the
  exclusions stay as above. Widening them without that file is guessing, and a skipped build
  that should have run ships nothing while looking like success.

- **~~`[vercel skip]` in the message.~~ It does not work.** Measured 2026-09-02 in `drakes`:
  `577a5dd` carried the marker, touched only `docs/` and `scripts/`, and **built anyway** —
  a real `READY` deployment. What had been skipping builds all along was the ignore command.
  The marker is fine as a note to a human about what a commit contains; **no close may treat
  it as the reason a build will not run.** The only thing that decides is the ignore command,
  and the only way to know is to look at the deployment afterwards.

- **One push per batch, never one per commit.** Ten commits pushed together are one
  deployment; pushed one at a time they are ten. Group the commits, run the gates, push once
  at the end.

**Verify against two real commits, never one.** One that should skip and one that should
build: comparing a docs-only commit against another docs-only commit proves only that the
command agrees with itself. Measured for this repository on 2026-09-02:

    SKIPS   681750f (.claude/ only)
    BUILDS  98a45cb (src/)

Measured 2026-09-02: the team's **100 deployments/day** — hobby plan, shared by all six
projects — ran out on rule-and-documentation commits (26 milliondollarpage, 22 drakes, 20
pixelwar, 17 kolscanhispano, 8 nftraffle, 7 bidoor-lol). Nothing could ship for 24 hours.
The quota is invisible until you ask for a deployment: the project's flags all read clean.
`~/.claude/GATES.md` has the incident.

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

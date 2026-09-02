import { execFileSync } from "node:child_process";
import { closeSync, constants, ftruncateSync, openSync, readFileSync, writeSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";

/**
 * One measuring suite at a time, on this whole machine.
 *
 * WHO CALLS THIS: this repository's vitest `globalSetup`, once, before any test
 * file loads — and the identical file in every other repository on this
 * machine. That is the entire point: unrelated projects agree on one path, so
 * the second run **queues** instead of competing.
 *
 * ## Why this exists, in numbers
 *
 * Measured 2026-09-02 in `milliondollarpage`: three runs of the same commit,
 * one comment apart, took **1269s green, then 2883s with three failures, then
 * 6249s with nine**. Every failure was `Connection terminated unexpectedly` or
 * `read ECONNRESET`, in the files that use the database hardest, and none of
 * them touched the code that had changed. The chain: another repository's suite
 * takes the cores, this run's workers wait for CPU, the wait passes Neon's idle
 * timeout of about five minutes, the server closes the connection, and the next
 * query on it fails. What lands in the log is a database error in whichever
 * file happened to be holding that connection — which reads as a product defect
 * and gets investigated as one.
 *
 * ## It WAITS. It does not refuse
 *
 * A refusal makes the second session's problem the second session's problem and
 * leaves the operator to re-run by hand. Queueing costs the same wall clock and
 * needs nobody. The cap is what stops a queue becoming a hang, and the refusal
 * at the cap names the holder — repository and PID — because a lock that fails
 * anonymously sends you looking in the wrong project.
 *
 * ## `flock`, not a sentinel file
 *
 * The lock is `O_EXLOCK` on the open, so the kernel owns it: **a run that is
 * killed releases it**, with no stale-PID rule to get right and no file for
 * anyone to delete by hand. Proven three ways before this was written — a
 * second acquire refused with `EAGAIN`, a close reacquired, and a `SIGKILL`ed
 * holder released immediately.
 *
 * ## What it is NOT
 *
 * Not the database advisory lock in `vitest.globalSetup.ts`, which serialises
 * runs of THIS suite against THIS database and reaches a second machine, which
 * a file cannot. Not `assertNoForeignSuite`, which stays as the net for the one
 * thing this lock cannot see: a browser-driving run in another repository,
 * which competes for CPU without ever running vitest.
 *
 * ## The one platform note
 *
 * `O_EXLOCK` is BSD, so this is macOS. Node does not expose the constant
 * (`fs.constants.O_EXLOCK` is `undefined` on this build), so the Darwin value is
 * written out and verified by `suite-lock.test.ts` rather than trusted. On any
 * other platform the lock is skipped with a line saying so — a CI box running
 * one suite alone does not need it, and a wrong constant that silently locked
 * nothing would be worse than no lock at all.
 */

/** Outside every repository, because it is shared by all of them. */
export const SUITE_LOCK_PATH = join(homedir(), ".claude", "suite.lock");

/** BSD `O_EXLOCK`. Node exposes `O_SHLOCK`/`O_EXLOCK` on no platform here. */
const O_EXLOCK_DARWIN = 0x20;

/** Long enough for a full suite ahead of us and most of a second. */
const WAIT_CAP_MS = 45 * 60 * 1_000;

/** Fast enough to start promptly, slow enough not to spin. */
const POLL_MS = 5_000;

export type Holder = { repo: string; cwd: string; pid: number; startedAt: string };

/**
 * Which REPOSITORY this run belongs to — not which directory it is sitting in.
 *
 * `basename(process.cwd())` was the first answer and it is wrong in the one
 * case that matters most: a throwaway worktree reports its own folder. Measured
 * 2026-09-02, a run in `~/proyectos/cinders-b22` announced itself as holding
 * the lock for `cinders-b22`, and the reader of that message has no way to know
 * that is `drakes.fun`. A lock that names the wrong project sends somebody
 * looking in the wrong repository, which is the exact failure the name is there
 * to prevent.
 *
 * THE ORIGIN REMOTE IS THE ANSWER, because it is the same string from every
 * checkout and every worktree of one repository — which is also why two
 * checkouts of the same project correctly report the same name: they ARE the
 * same project, and the `cwd` beside it says which copy.
 *
 * The fallbacks descend rather than guess: the MAIN working tree (a worktree's
 * `--git-common-dir` points at the real repository's `.git`, so its parent is
 * that repository's directory), and finally the directory, which is what a
 * folder with no git at all can honestly say.
 */
export function repoNameFrom(
  remote: string | null,
  gitCommonDir: string | null,
  cwd: string,
): string {
  const fromRemote = (remote ?? "").trim().replace(/\/+$/, "");
  if (fromRemote !== "") return basename(fromRemote).replace(/\.git$/, "");

  const common = (gitCommonDir ?? "").trim();
  // `.git` in the main working tree, `<main>/.git/worktrees/<name>` in a
  // worktree — `--git-common-dir` gives the first even from inside the second.
  if (common.endsWith(".git")) return basename(dirname(common));

  return basename(cwd);
}

function git(args: string[]): string | null {
  try {
    return execFileSync("git", args, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  } catch {
    return null;
  }
}

export function repoName(): string {
  return repoNameFrom(
    git(["config", "--get", "remote.origin.url"]),
    git(["rev-parse", "--path-format=absolute", "--git-common-dir"]),
    process.cwd(),
  );
}
export type SuiteLock = { release: () => void; skipped: boolean };

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function lockFlags(): number | null {
  if (process.platform !== "darwin") return null;
  return constants.O_CREAT | constants.O_RDWR | O_EXLOCK_DARWIN | constants.O_NONBLOCK;
}

/**
 * Who holds it, as the file says — readable while locked, because the lock is
 * advisory and guards the open rather than the bytes.
 *
 * Returns null for a file that is empty, absent or half-written: a holder that
 * has taken the lock and not yet written its name is a real state, and it lasts
 * microseconds.
 */
export function readHolder(path = SUITE_LOCK_PATH): Holder | null {
  try {
    const text = readFileSync(path, "utf8").trim();
    if (text === "") return null;
    const holder = JSON.parse(text) as Holder;
    return typeof holder.pid === "number" ? holder : null;
  } catch {
    return null;
  }
}

function describe(holder: Holder | null): string {
  if (!holder) return "another run (it has not written its name yet)";
  const since = Number.isNaN(Date.parse(holder.startedAt))
    ? holder.startedAt
    : `${Math.round((Date.now() - Date.parse(holder.startedAt)) / 1_000)}s ago`;
  const where = holder.cwd && basename(holder.cwd) !== holder.repo ? ` in ${holder.cwd}` : "";
  return `${holder.repo}${where} (pid ${holder.pid}, started ${since})`;
}

/**
 * Takes the machine-wide suite lock, waiting for it, and hands back the release.
 *
 * The seams are parameters so the tests can drive both branches in
 * milliseconds instead of forty-five minutes. Every default is the real value.
 */
export async function takeSuiteLock(
  options: {
    path?: string;
    capMs?: number;
    pollMs?: number;
    announce?: (message: string) => void;
    repo?: string;
  } = {},
): Promise<SuiteLock> {
  const path = options.path ?? SUITE_LOCK_PATH;
  const capMs = options.capMs ?? WAIT_CAP_MS;
  const pollMs = options.pollMs ?? POLL_MS;
  const announce = options.announce ?? ((message: string) => console.log(message));
  const repo = options.repo ?? repoName();

  const flags = lockFlags();
  if (flags === null) {
    announce(
      `The machine-wide suite lock is macOS-only (O_EXLOCK) and this is ${process.platform}. ` +
        "Running without it.",
    );
    return { release: () => {}, skipped: true };
  }

  const startedAt = Date.now();
  let announced = false;

  for (;;) {
    let fd: number;
    try {
      fd = openSync(path, flags);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      // EAGAIN is "somebody holds it". Anything else — a missing ~/.claude, a
      // permission problem — is not a queue and must not be waited out.
      if (code !== "EAGAIN" && code !== "EWOULDBLOCK") throw error;

      const waited = Date.now() - startedAt;
      if (waited >= capMs) {
        throw new Error(
          `Gave up after ${Math.round(waited / 60_000)} minutes waiting for the machine-wide ` +
            `suite lock, held by ${describe(readHolder(path))}. Two suites at once is what this ` +
            "queue exists to prevent: the second one's workers wait for CPU past Postgres's " +
            "idle timeout and come back to a closed connection. Wait for it, or stop it BY PID — " +
            "never `pkill` by name.",
        );
      }

      if (!announced) {
        // Once, not per poll: a line every five seconds for forty-five minutes
        // is five hundred lines around the one that matters.
        announce(
          `Waiting for the machine-wide suite lock, held by ${describe(readHolder(path))}. ` +
            `Giving up after ${Math.round(capMs / 60_000)} minutes.`,
        );
        announced = true;
      }

      await sleep(Math.min(pollMs, capMs - waited));
      continue;
    }

    // Ours. Say who we are, for whoever waits behind us.
    const holder: Holder = {
      repo,
      // The checkout, beside the repository, because two worktrees of one
      // project are one repository and two directories, and the reader needs
      // both to go and look.
      cwd: process.cwd(),
      pid: process.pid,
      startedAt: new Date().toISOString(),
    };
    ftruncateSync(fd, 0);
    writeSync(fd, JSON.stringify(holder), 0);

    if (announced) {
      announce(`Took the machine-wide suite lock after ${Math.round((Date.now() - startedAt) / 1_000)}s.`);
    }

    let released = false;
    return {
      skipped: false,
      release: () => {
        if (released) return;
        released = true;
        // Closing the descriptor is what releases the lock, which is also what
        // happens when a run is killed rather than exiting cleanly.
        try {
          closeSync(fd);
        } catch {
          // Already closed, or the process is going down anyway.
        }
      },
    };
  }
}

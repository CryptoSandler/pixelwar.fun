import { execFileSync, spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { readHolder, repoName, repoNameFrom, takeSuiteLock } from "../../../suite-lock";

/**
 * The machine-wide queue, and the three properties the whole design rests on.
 *
 * It runs against a lock file in a temporary directory rather than the real one
 * in `~/.claude` — this suite is holding the real one while it runs, and a test
 * that took it again would deadlock against itself.
 */

const room = mkdtempSync(join(tmpdir(), "suite-lock-"));
const LOCK = join(room, "suite.lock");

afterAll(() => rmSync(room, { recursive: true, force: true }));

/** A second process that takes the lock and holds it until it is killed. */
function holderProcess(path: string): { pid: number; stop: () => void } {
  const source =
    `const fs=require("fs");` +
    `fs.openSync(${JSON.stringify(path)}, fs.constants.O_CREAT|fs.constants.O_RDWR|0x20|fs.constants.O_NONBLOCK);` +
    `fs.writeFileSync(${JSON.stringify(path)}, JSON.stringify({repo:"another-repo",cwd:"/somewhere/else",pid:process.pid,startedAt:new Date().toISOString()}));` +
    `setTimeout(()=>{}, 120000);`;
  const child = spawn(process.execPath, ["-e", source], { stdio: "ignore" });
  // The child has to have opened the file before the assertions run. A short
  // poll rather than a sleep, so this is not a timing test.
  const until = Date.now() + 5_000;
  while (Date.now() < until && readHolder(path) === null) execFileSync("sleep", ["0.05"]);
  return { pid: child.pid!, stop: () => child.kill("SIGKILL") };
}

/**
 * WHICH REPOSITORY IS HOLDING IT, which is not the same question as which
 * directory the run is in.
 *
 * The first version answered `basename(process.cwd())`, and on 2026-09-02 a run
 * in the throwaway worktree `~/proyectos/cinders-b22` announced itself as
 * `cinders-b22` — a name that appears in no repository, sending whoever read
 * the message looking for a project that does not exist.
 */
describe("who the lock says is holding it", () => {
  it("names the repository, not the worktree the run happens to be in", () => {
    expect(
      repoNameFrom(
        "https://CryptoSandler@github.com/CryptoSandler/drakes.fun.git",
        "/Users/fede/proyectos/cinders/.git",
        "/var/folders/T/tmp.abc/worktrees/drakes",
      ),
    ).toBe("drakes.fun");
  });

  it("falls back to the MAIN working tree when there is no remote", () => {
    // `--git-common-dir` from inside a worktree points at the real repository's
    // own `.git`, which is what makes this the right fallback rather than a
    // second way of reading the directory the run is in.
    expect(repoNameFrom(null, "/Users/fede/proyectos/pixelwar/.git", "/tmp/wt/anything")).toBe(
      "pixelwar",
    );
  });

  it("falls back to the directory only when there is no git at all", () => {
    expect(repoNameFrom("", "", "/Users/fede/scratch/thing")).toBe("thing");
  });

  /*
    THE EXPECTATION IS DERIVED, NOT WRITTEN DOWN, and that is the whole point of
    this case. The first version asserted the literal `milliondollarpage.fun`,
    and this file is copied verbatim into five repositories — so in `drakes` it
    failed with `expected 'drakes.fun' to be 'milliondollarpage.fun'`, which is
    the function being RIGHT and the test being wrong about where it lives.
  */
  it("reads this repository's own name off git rather than off the folder", () => {
    const remote = execFileSync("git", ["config", "--get", "remote.origin.url"], {
      encoding: "utf8",
    }).trim();
    const expected = basename(remote.replace(/\/+$/, "")).replace(/\.git$/, "");

    expect(repoName()).toBe(expected);
    // And where the checkout is named differently from the repository — which
    // is true here, and in every worktree anywhere — the folder is not what
    // comes back.
    if (expected !== basename(process.cwd())) {
      expect(repoName()).not.toBe(basename(process.cwd()));
    }
  });
});

describe("the machine-wide suite lock", () => {
  it("waits for a holder rather than refusing, and says who has it", async () => {
    const other = holderProcess(LOCK);
    const said: string[] = [];

    try {
      await expect(
        takeSuiteLock({ path: LOCK, capMs: 300, pollMs: 50, announce: (m: string) => said.push(m) }),
      ).rejects.toThrow(/waiting for the machine-wide suite lock/);

      // The wait is announced once, and it names the repository and the PID —
      // a lock that fails anonymously sends you looking in the wrong project.
      expect(said).toHaveLength(1);
      expect(said[0]).toContain("another-repo");
      expect(said[0]).toContain(`pid ${other.pid}`);
    } finally {
      other.stop();
    }
  });

  /**
   * The property that makes this a lock rather than a sentinel file: nobody has
   * to notice that a holder died, and there is no stale-PID rule to get wrong.
   */
  it("is released by a holder that is killed, with nothing to clean up", async () => {
    const other = holderProcess(LOCK);
    other.stop();

    // No poll and no grace period: the kernel drops the lock with the process.
    const mine = await takeSuiteLock({ path: LOCK, capMs: 5_000, pollMs: 50, announce: () => {} });
    try {
      expect(mine.skipped).toBe(false);
      expect(readHolder(LOCK)).toMatchObject({ pid: process.pid });
    } finally {
      mine.release();
    }
  });

  it("hands the lock straight to the next taker on release", async () => {
    const first = await takeSuiteLock({ path: LOCK, capMs: 1_000, pollMs: 50, announce: () => {}, repo: "first" });
    expect(readHolder(LOCK)).toMatchObject({ repo: "first" });
    first.release();

    const second = await takeSuiteLock({ path: LOCK, capMs: 1_000, pollMs: 50, announce: () => {}, repo: "second" });
    try {
      expect(readHolder(LOCK)).toMatchObject({ repo: "second" });
    } finally {
      second.release();
    }
  });

  it("releases once however many times it is asked", async () => {
    const mine = await takeSuiteLock({ path: LOCK, capMs: 1_000, pollMs: 50, announce: () => {} });
    mine.release();
    // A second release must not close a descriptor number this process has
    // since reused for something else.
    expect(() => mine.release()).not.toThrow();
  });
});

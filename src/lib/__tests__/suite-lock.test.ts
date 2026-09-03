import { execFileSync, spawn } from "node:child_process";
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  nextInLine,
  readHolder,
  readQueue,
  repoName,
  repoNameFrom,
  takeSuiteLock,
  ticketName,
  type Ticket,
} from "../../../suite-lock";

/**
 * The machine-wide queue, and the three properties the whole design rests on.
 *
 * It runs against a lock file in a temporary directory rather than the real one
 * in `~/.claude` — this suite is holding the real one while it runs, and a test
 * that took it again would deadlock against itself.
 */

const room = mkdtempSync(join(tmpdir(), "suite-lock-"));
const LOCK = join(room, "suite.lock");
/*
  ITS OWN QUEUE DIRECTORY, and forgetting it is the one way this file could do
  damage: the default is `~/.claude/suite-queue`, which is the real queue every
  repository on this machine is standing in. A test that wrote tickets there
  would put phantom waiters in front of real runs.
*/
const QUEUE = join(room, "suite-queue");

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
        takeSuiteLock({
          path: LOCK,
          queueDir: QUEUE,
          capMs: 300,
          pollMs: 50,
          announce: (m: string) => said.push(m),
        }),
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
    const mine = await takeSuiteLock({ path: LOCK, queueDir: QUEUE, capMs: 5_000, pollMs: 50, announce: () => {} });
    try {
      expect(mine.skipped).toBe(false);
      expect(readHolder(LOCK)).toMatchObject({ pid: process.pid });
    } finally {
      mine.release();
    }
  });

  it("hands the lock straight to the next taker on release", async () => {
    const first = await takeSuiteLock({ path: LOCK, queueDir: QUEUE, capMs: 1_000, pollMs: 50, announce: () => {}, repo: "first" });
    expect(readHolder(LOCK)).toMatchObject({ repo: "first" });
    first.release();

    const second = await takeSuiteLock({ path: LOCK, queueDir: QUEUE, capMs: 1_000, pollMs: 50, announce: () => {}, repo: "second" });
    try {
      expect(readHolder(LOCK)).toMatchObject({ repo: "second" });
    } finally {
      second.release();
    }
  });

  it("releases once however many times it is asked", async () => {
    const mine = await takeSuiteLock({ path: LOCK, queueDir: QUEUE, capMs: 1_000, pollMs: 50, announce: () => {} });
    mine.release();
    // A second release must not close a descriptor number this process has
    // since reused for something else.
    expect(() => mine.release()).not.toThrow();
  });
});

/**
 * FAIRNESS, which is the property `flock` on its own does not have.
 *
 * The kernel lock is a scramble: whoever calls `open` at the instant the holder
 * closes wins it, and a repository that runs suites back to back wins that race
 * over and over. Measured on 2026-09-03 on this machine — one project held the
 * lock for most of thirteen hours, and this repository's close reached the
 * 45-minute cap **without a single test having run**. That is the incident this
 * queue exists for, and these are the assertions that say it cannot happen
 * again.
 */
describe("the queue is in arrival order", () => {
  it("names tickets so that sorting the filenames is sorting by arrival", () => {
    // Zero-padded, so a lexical listing is already chronological and nothing
    // has to parse a filename to compare two of them.
    expect([ticketName(1_000, 7), ticketName(999, 9), ticketName(1_000, 2)].sort()).toEqual([
      ticketName(999, 9),
      ticketName(1_000, 2),
      ticketName(1_000, 7),
    ]);
  });

  it("puts the oldest first and tears up the tickets of processes that died", () => {
    const dir = mkdtempSync(join(room, "q-"));
    const write = (at: number, id: number) =>
      writeFileSync(join(dir, ticketName(at, id)), JSON.stringify({ at, id, repo: `r${id}`, cwd: "/" }));

    write(300, 3);
    write(100, 1);
    write(200, 2);

    // 2 is gone. Its ticket must not hold the place it can no longer use.
    const line = readQueue(dir, (id) => id !== 2, 400, 10_000);
    expect(line.map((t) => t.id)).toEqual([1, 3]);
    expect(nextInLine(line)?.id).toBe(1);
    // And it is gone from the directory, not merely skipped in memory.
    expect(readdirSync(dir)).toHaveLength(2);
  });

  it("tears up a ticket older than twice the cap, for a pid something else has reused", () => {
    const dir = mkdtempSync(join(room, "q-"));
    writeFileSync(join(dir, ticketName(1, 1)), JSON.stringify({ at: 1, id: 1, repo: "ancient", cwd: "/" }));
    expect(readQueue(dir, () => true, 100_000, 1_000)).toHaveLength(0);
  });

  it("tears up a ticket nobody can read rather than queueing behind it for ever", () => {
    const dir = mkdtempSync(join(room, "q-"));
    writeFileSync(join(dir, ticketName(1, 1)), "{ this is not json");
    expect(readQueue(dir, () => true, 2, 10_000)).toHaveLength(0);
    expect(readdirSync(dir)).toHaveLength(0);
  });

  /**
   * THE CASE THE OWNER ASKED FOR: two waiting, and the holder asks again the
   * instant it lets go.
   *
   * On a bare `flock` the re-requester wins about as often as not — it is
   * already running, already in the syscall, and the two waiters are asleep in
   * a five-second poll. Here it goes to the BACK, and it needs no rule of its
   * own: a ticket is written when the lock is REQUESTED, so asking again is
   * arriving again.
   *
   * Three waiters from one process, which is why `id` and `isAlive` are
   * parameters — `process.kill(pid, 0)` would call all three of them alive
   * because they ARE all one process.
   */
  it("hands the lock to the oldest ticket, and a run that just released goes last", async () => {
    const dir = mkdtempSync(join(room, "q-"));
    const lock = join(dir, "lock");
    const order: string[] = [];
    const common = { path: lock, queueDir: dir, capMs: 15_000, pollMs: 20, isAlive: () => true, announce: () => {} };

    // The holder, in first because somebody has to be.
    const holder = await takeSuiteLock({ ...common, id: 1, repo: "holder" });

    /** Asks for the lock, records the moment it gets it, and lets go shortly after. */
    const join_ = (name: string, id: number) =>
      takeSuiteLock({ ...common, id, repo: name }).then((held) => {
        order.push(name);
        return new Promise<void>((done) =>
          setTimeout(() => {
            held.release();
            done();
          }, 60),
        );
      });

    const a = join_("A", 2);
    await new Promise((r) => setTimeout(r, 60));
    const b = join_("B", 3);
    await new Promise((r) => setTimeout(r, 60));

    // The holder lets go and asks again in the same breath. This is the move
    // that used to win.
    holder.release();
    const again = join_("holder-again", 4);

    await Promise.all([a, b, again]);

    expect(order).toEqual(["A", "B", "holder-again"]);
    // And nobody left a ticket behind.
    expect(readdirSync(dir).filter((f) => f.endsWith(".json"))).toHaveLength(0);
  }, 30_000);

  it("gives up naming the queue it is standing in, not just the holder", async () => {
    const dir = mkdtempSync(join(room, "q-"));
    const lock = join(dir, "lock");
    const said: string[] = [];

    /*
      SOMEBODY AHEAD OF US WHO IS NEVER GOING TO MOVE — and their ticket has to
      be RECENT as well as older than ours. The first draft dated it `at: 1`,
      which is 1970: `readQueue` tears up anything older than the cap, so the
      queue came back empty, this run took the lock, and the assertion failed
      with the code being right. That prune is the pid-reuse guard two cases up.
    */
    const ahead: Omit<Ticket, "file"> = {
      at: Date.now() - 50,
      id: 99,
      repo: "ahead-of-us",
      cwd: "/elsewhere",
    };
    writeFileSync(join(dir, ticketName(ahead.at, ahead.id)), JSON.stringify(ahead));

    await expect(
      takeSuiteLock({
        path: lock,
        queueDir: dir,
        capMs: 200,
        pollMs: 20,
        id: 100,
        isAlive: () => true,
        repo: "us",
        announce: (m: string) => said.push(m),
      }),
    ).rejects.toThrow(/waiting in the machine-wide suite queue, 2 of 2, behind ahead-of-us/);

    expect(said).toHaveLength(1);
    expect(said[0]).toContain("2 of 2, behind ahead-of-us");
    // And our own ticket went with us: a place in line held by a run that has
    // already given up is a place nobody behind it can get past.
    expect(readQueue(dir, () => true, Date.now(), 10_000).map((t) => t.id)).toEqual([99]);
  });
});

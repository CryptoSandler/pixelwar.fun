import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

/**
 * The Ignored Build Step, fired at four commits it has to answer differently.
 *
 * WHAT THIS EXISTS FOR, in one incident. On 2026-09-03 this repository pushed
 * three commits together — the batch's code, and then
 * `docs/cierre-2026-09-03.md` on top. The ignore command compared `HEAD^ HEAD`,
 * saw one documentation file, exited 0, and Vercel reported **CANCELED for the
 * whole push**. The two commits underneath it — a new header, a new strip,
 * three new routes — never deployed. `/` answered 200 and every new route
 * answered 404, and the gates had all been green.
 *
 * The rule that groups a batch into ONE push is what makes the tip commit
 * unrepresentative of it, so `HEAD^` was never the right base. The command
 * compares against `$VERCEL_GIT_PREVIOUS_SHA` — the last SUCCESSFUL deployment
 * for this branch — which is the question actually being asked: has anything
 * outside docs changed since the thing production is currently running.
 *
 * ## Why it builds a repository instead of using this one
 *
 * The four cases need commits with known contents in a known order, and this
 * file is copied verbatim into seven repositories whose histories have nothing
 * in common. A repository built in a temporary directory gives every copy the
 * same four commits, and it exercises the REAL command out of the REAL
 * `vercel.json` rather than a paraphrase of it — which is the half a unit test
 * of a shell string cannot do.
 *
 * ## The direction that must never flip
 *
 * Exit 0 skips the build; exit 1 builds it. Every case where the command cannot
 * PROVE that nothing outside docs changed must build. `~/.claude/GATES.md`:
 * *not being able to prove nothing changed never resolves to skipping.*
 */

const room = mkdtempSync(join(tmpdir(), "ignore-step-"));
afterAll(() => rmSync(room, { recursive: true, force: true }));

/** The command Vercel will actually run, read from the file Vercel reads. */
function ignoreCommand(): string {
  const config = JSON.parse(readFileSync("vercel.json", "utf8")) as { ignoreCommand?: string };
  if (!config.ignoreCommand) throw new Error("vercel.json carries no ignoreCommand");
  return config.ignoreCommand;
}

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
    // Committing needs an identity, and a machine that happens to have none
    // configured is not a reason for this to fail.
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "t",
      GIT_AUTHOR_EMAIL: "t@example.com",
      GIT_COMMITTER_NAME: "t",
      GIT_COMMITTER_EMAIL: "t@example.com",
    },
  }).trim();
}

/**
 * Three commits: something before, a CODE change, and a DOCS-ONLY tip.
 *
 * That is the shape of the push that was cancelled, and the only shape in which
 * `HEAD^ HEAD` and the real question give different answers.
 */
function history(): { dir: string; before: string; code: string; docs: string } {
  const dir = mkdtempSync(join(room, "repo-"));
  git(dir, ["init", "-q", "-b", "main"]);

  writeFileSync(join(dir, "README.md"), "start\n");
  git(dir, ["add", "-A"]);
  git(dir, ["commit", "-q", "-m", "start"]);
  const before = git(dir, ["rev-parse", "HEAD"]);

  mkdirSync(join(dir, "src"), { recursive: true });
  writeFileSync(join(dir, "src", "page.tsx"), "export default function Page() {}\n");
  git(dir, ["add", "-A"]);
  git(dir, ["commit", "-q", "-m", "a route somebody is going to want served"]);
  const code = git(dir, ["rev-parse", "HEAD"]);

  mkdirSync(join(dir, "docs"), { recursive: true });
  writeFileSync(join(dir, "docs", "cierre.md"), "what the batch changed\n");
  git(dir, ["add", "-A"]);
  git(dir, ["commit", "-q", "-m", "the close"]);
  const docs = git(dir, ["rev-parse", "HEAD"]);

  return { dir, before, code, docs };
}

/** What Vercel would do: 0 is skip, anything else is build. */
function verdict(dir: string, previousSha: string): "skip" | "build" {
  try {
    execFileSync("bash", ["-c", ignoreCommand()], {
      cwd: dir,
      stdio: "ignore",
      env: { ...process.env, VERCEL_GIT_PREVIOUS_SHA: previousSha },
    });
    return "skip";
  } catch {
    return "build";
  }
}

describe("the ignored build step", () => {
  const repo = history();

  it("BUILDS when code has changed since the last deployment", () => {
    // The batch's own case: three commits pushed together, the last docs-only.
    // This is what was answered wrongly, and it is the whole reason for the file.
    expect(verdict(repo.dir, repo.before)).toBe("build");
  });

  it("SKIPS when only documentation has changed since the last deployment", () => {
    expect(verdict(repo.dir, repo.code)).toBe("skip");
  });

  it("BUILDS when there is no previous deployment to compare against", () => {
    expect(verdict(repo.dir, "")).toBe("build");
  });

  it("BUILDS when the previous sha is not in the shallow clone", () => {
    // Vercel clones shallowly. A base it cannot resolve is a question it cannot
    // answer, and an unanswerable question builds.
    expect(verdict(repo.dir, "0".repeat(40))).toBe("build");
  });

  /**
   * The old command, on the same history, answering wrongly — so the fix is
   * demonstrated against the defect rather than merely asserted.
   */
  it("and `HEAD^ HEAD` would have skipped that push, which is the defect", () => {
    let skipped = true;
    try {
      execFileSync(
        "bash",
        [
          "-c",
          'git diff --quiet HEAD^ HEAD -- ":(exclude)docs" ":(exclude).claude" ":(exclude,glob)*.md"',
        ],
        { cwd: repo.dir, stdio: "ignore" },
      );
    } catch {
      skipped = false;
    }
    expect(skipped).toBe(true);
  });

  it("excludes root-level markdown without excluding it at every depth", () => {
    // `,glob` is load-bearing: without it `*` matches `/` and `src/x.md` would
    // be excluded too — and a repository that serves markdown would stop
    // deploying changes to it.
    const dir = mkdtempSync(join(room, "md-"));
    git(dir, ["init", "-q", "-b", "main"]);
    writeFileSync(join(dir, "README.md"), "a\n");
    git(dir, ["add", "-A"]);
    git(dir, ["commit", "-q", "-m", "start"]);
    const base = git(dir, ["rev-parse", "HEAD"]);

    mkdirSync(join(dir, "src"), { recursive: true });
    writeFileSync(join(dir, "src", "content.md"), "served\n");
    git(dir, ["add", "-A"]);
    git(dir, ["commit", "-q", "-m", "markdown that is content, not documentation"]);

    expect(verdict(dir, base)).toBe("build");
  });
});

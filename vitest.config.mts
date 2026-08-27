import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    setupFiles: ["./vitest.setup.ts"],
    // Runs ONCE per run, unlike setupFiles which runs per test file. The
    // one-run-at-a-time advisory lock lives there for exactly that reason.
    globalSetup: ["./vitest.global-setup.ts"],
    // One fork. Later tasks add tests that truncate shared tables, and running
    // files in parallel would have them delete each other's fixtures
    // mid-assertion.
    //
    // Vitest 4 removed the nested `poolOptions.forks.singleFork` toggle the
    // plan specified (poolOptions was removed entirely); `fileParallelism:
    // false` is the current top-level replacement and has the same effect —
    // it forces a single worker instead of running files in parallel.
    pool: "forks",
    fileParallelism: false,
  },
});

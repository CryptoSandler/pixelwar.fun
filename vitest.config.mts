import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    setupFiles: ["./vitest.setup.ts"],
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
    // Every test here talks to real Neon over the network rather than a local
    // Postgres, so a fixture loop of a dozen paints is a few dozen round
    // trips, not a few dozen milliseconds. Vitest's 5s default is tuned for
    // in-process work and clips tests like that well before they are actually
    // stuck; 20s gives real network latency room without hiding a genuine
    // hang for anywhere near as long as a CI timeout would.
    testTimeout: 20_000,
  },
});

import { config } from "dotenv";
import { Client } from "pg";

/**
 * One test run at a time against this database.
 *
 * WHY THIS IS A `globalSetup` AND NOT PART OF `vitest.setup.ts`. It was part
 * of `vitest.setup.ts`, and that was wrong in a way that took a hung suite to
 * find: **`setupFiles` runs once per test FILE, not once per run.** The lock
 * was therefore taken and released forty-three times in a single suite,
 * opening forty-three connections to the direct (non-pooled) endpoint, and —
 * worse — leaving the lock free in the gaps between files, which is precisely
 * where a second run would slip in. It protected less than it claimed while
 * costing more than it looked.
 *
 * `globalSetup` runs once, in the main process, and its returned function runs
 * once at the end. One connection, one lock, held across the whole run.
 *
 * WHAT THE LOCK IS FOR. `fileParallelism: false` stops files inside one run
 * from racing. It does nothing about two runs — two sessions, two terminals,
 * two branches — and those truncate each other's fixtures mid-assertion. That
 * is not hypothetical: it produced twenty-five failures in one sitting that
 * read exactly like product bugs.
 */

config({ path: ".env.local" });

const SUITE_LOCK_KEY = 8_140_255_301;
const SUITE_LOCK_TIMEOUT_MS = 10 * 60 * 1000;

/**
 * The DIRECT connection string, with Neon's pooler host removed.
 *
 * A correctness requirement, not an optimisation. The pooled endpoint is
 * PgBouncer in transaction mode: it hands one server connection to a
 * different client between transactions, so a SESSION-level advisory lock
 * taken through it is released at a moment nobody controls. It would appear
 * to work and protect nothing.
 */
function directUrl(url: string): string {
  const parsed = new URL(url);
  parsed.hostname = parsed.hostname.replace("-pooler", "");
  return parsed.toString();
}

export async function setup(): Promise<() => Promise<void>> {
  const test = process.env.TEST_DATABASE_URL?.trim();
  if (!test) {
    throw new Error(
      "TEST_DATABASE_URL is not set. The suite truncates every table, so it " +
        "refuses to run without a database that is explicitly disposable.",
    );
  }

  const client = new Client({ connectionString: directUrl(test) });
  await client.connect();

  // Blocking, with a ceiling, and the message names which situation this is:
  // "another run is going" and "a run died holding it" need different
  // responses from whoever is reading the terminal.
  const deadline = Date.now() + SUITE_LOCK_TIMEOUT_MS;
  for (;;) {
    const taken = await client.query<{ locked: boolean }>(
      "SELECT pg_try_advisory_lock($1) AS locked",
      [SUITE_LOCK_KEY],
    );
    if (taken.rows[0].locked) break;
    if (Date.now() >= deadline) {
      await client.end().catch(() => {});
      throw new Error(
        "Another test run has held this database for ten minutes. Either one is " +
          "still going (wait for it), or one died without releasing — an advisory " +
          "lock dies with its session, so reconnecting clears it.",
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 2_000));
  }

  return async () => {
    await client.query("SELECT pg_advisory_unlock($1)", [SUITE_LOCK_KEY]).catch(() => {});
    await client.end().catch(() => {});
  };
}

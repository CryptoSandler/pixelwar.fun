import { config } from "dotenv";
import { Client } from "pg";
import { afterAll, beforeAll, beforeEach } from "vitest";
import { closePool, execute, query } from "./src/lib/db";

config({ path: ".env.local" });

/**
 * The key every pixelwar test run locks on. Arbitrary, and it only has to be
 * stable and unlikely to collide with anything else using advisory locks on
 * the same database — nothing in the application does.
 */
const SUITE_LOCK_KEY = 8_140_255_301;

/** How long to wait for another run to finish before giving up and saying so. */
const SUITE_LOCK_TIMEOUT_MS = 10 * 60 * 1000;

/**
 * Holds the run's advisory lock. A dedicated connection, not the pool's:
 * a session-level lock belongs to the session that took it, and the pool
 * hands its connections back after every query.
 */
let lockClient: Client | null = null;

/**
 * The DIRECT connection string for `url`, with Neon's pooler host removed.
 *
 * This is not an optimisation, it is a correctness requirement. The pooled
 * endpoint is PgBouncer in transaction mode: it hands one server connection
 * to a different client between transactions, so a SESSION-level advisory
 * lock taken through it is held by whichever backend happens to be on the
 * other end and released at a moment nobody controls. The lock would appear
 * to work and would protect nothing.
 */
function directUrl(url: string): string {
  const parsed = new URL(url);
  parsed.hostname = parsed.hostname.replace("-pooler", "");
  return parsed.toString();
}

beforeAll(async () => {
  const test = process.env.TEST_DATABASE_URL?.trim();
  const app = process.env.DATABASE_URL?.trim();

  if (!test) {
    throw new Error(
      "TEST_DATABASE_URL is not set. The suite truncates every table, so it " +
        "refuses to run without a database that is explicitly disposable.",
    );
  }
  // Compare where the two URLs POINT, not how they are spelled. A trailing
  // slash, a different letter case in the host, or an extra query parameter
  // makes two strings unequal while they still address the same database —
  // and this guard is the only thing between a hand-edited .env.local and
  // TRUNCATE running against production.
  if (sameTarget(test, app)) {
    throw new Error(
      "TEST_DATABASE_URL and DATABASE_URL point at the same database. The suite " +
        "truncates every table; pointing it at the app database would delete real data.",
    );
  }

  // Everything under test reads DATABASE_URL. Redirect it once, here.
  process.env.DATABASE_URL = test;

  // ONE RUN AT A TIME AGAINST THIS DATABASE.
  //
  // `fileParallelism: false` in vitest.config.mts stops files inside ONE run
  // from racing. It does nothing about two runs — two branches, two sessions,
  // two terminals — pointed at the same TEST_DATABASE_URL, and those truncate
  // each other's fixtures mid-assertion. That is not hypothetical: it
  // produced twenty-five failures in one sitting that looked exactly like
  // product bugs, and the better part of an hour went into diagnosing a
  // collision rather than a defect.
  //
  // A lock rather than a per-run schema because the failure it prevents is
  // rare, the wait it costs is only paid when somebody is genuinely already
  // running, and the alternative — a database per run — is what
  // CLAUDE.md reserves for branches that carry migrations, where the schemas
  // genuinely differ.
  //
  // Blocking, with a ceiling. `pg_advisory_lock` would wait forever on a run
  // that hung; the loop below gives up and says which situation this is,
  // because "your suite has been waiting ten minutes" and "your suite is
  // stuck" need different responses from whoever is reading.
  lockClient = new Client({ connectionString: directUrl(test) });
  await lockClient.connect();

  const deadline = Date.now() + SUITE_LOCK_TIMEOUT_MS;
  for (;;) {
    const taken = await lockClient.query<{ locked: boolean }>(
      "SELECT pg_try_advisory_lock($1) AS locked",
      [SUITE_LOCK_KEY],
    );
    if (taken.rows[0].locked) break;
    if (Date.now() >= deadline) {
      await lockClient.end();
      lockClient = null;
      throw new Error(
        "Another test run has held this database for ten minutes. Either a run is " +
          "still going (wait for it), or one died without releasing — reconnecting " +
          "clears it, since an advisory lock dies with its session.",
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 2_000));
  }
});

/**
 * True when two connection strings address the same database.
 *
 * Host, port and database name only. Credentials and query parameters are
 * deliberately ignored: connecting as a different role, or with a different
 * sslmode, still truncates the same tables.
 *
 * An unparseable URL is treated as a match — refusing to run is the safe
 * answer when we cannot tell what we are pointed at. A missing second URL
 * (DATABASE_URL unset) is treated as no match: there is nothing for the
 * first URL to collide with.
 */
export function sameTarget(a: string, b: string | undefined): boolean {
  if (b === undefined) return false;
  try {
    const left = new URL(a);
    const right = new URL(b);
    const key = (url: URL) =>
      `${url.hostname.toLowerCase()}:${url.port || "5432"}${url.pathname.replace(/\/+$/, "")}`;
    return key(left) === key(right);
  } catch {
    return true;
  }
}

/** Empties every table except the migration ledger. */
export async function truncateAll(): Promise<void> {
  const tables = await query<{ tablename: string }>(
    `SELECT tablename FROM pg_tables
      WHERE schemaname = 'public' AND tablename <> 'schema_migrations'`,
  );
  if (tables.length === 0) return;
  await execute(`TRUNCATE ${tables.map((t) => `"${t.tablename}"`).join(", ")} CASCADE`);
}

beforeEach(truncateAll);

afterAll(async () => {
  await closePool();
  // Ending the connection releases the lock. Doing it explicitly anyway so a
  // reader does not have to know that, and so the next run's wait ends the
  // moment this one does rather than whenever the socket happens to close.
  if (lockClient) {
    await lockClient.query("SELECT pg_advisory_unlock($1)", [SUITE_LOCK_KEY]).catch(() => {});
    await lockClient.end().catch(() => {});
    lockClient = null;
  }
});

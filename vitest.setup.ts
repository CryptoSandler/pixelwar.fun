import { config } from "dotenv";
import { afterAll, beforeAll, beforeEach } from "vitest";
import { closePool, execute, query } from "./src/lib/db";

config({ path: ".env.local" });

beforeAll(() => {
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

  // The one-run-at-a-time advisory lock used to live here and does NOT any
  // more: `setupFiles` runs once per test FILE, so it was taken and released
  // once per file, leaving the lock free in the gaps and opening a direct
  // connection per file. It is in `vitest.global-setup.ts` now, which runs
  // once per run. See that file.
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

afterAll(closePool);

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
  if (test === app) {
    throw new Error(
      "TEST_DATABASE_URL equals DATABASE_URL. The suite truncates every table; " +
        "pointing it at the app database would delete real data.",
    );
  }

  // Everything under test reads DATABASE_URL. Redirect it once, here.
  process.env.DATABASE_URL = test;
});

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

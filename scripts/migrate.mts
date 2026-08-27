import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { config } from "dotenv";
import { Pool } from "pg";

/**
 * Applies every unapplied migration, in filename order, each inside its own
 * transaction. A migration that throws leaves the database exactly as it was
 * and stops the run: applying half a schema and reporting success is the one
 * outcome a migration tool must never produce.
 */

config({ path: ".env.local" });

const useTest = process.argv.includes("--test");
const url = useTest ? process.env.TEST_DATABASE_URL : process.env.DATABASE_URL;

if (!url) {
  console.error(
    `${useTest ? "TEST_DATABASE_URL" : "DATABASE_URL"} is not set. There is no default: ` +
      "a fallback would mean migrating the wrong database rather than failing.",
  );
  process.exit(1);
}

const pool = new Pool({ connectionString: url });
const dir = join(process.cwd(), "migrations");

await pool.query(`
  CREATE TABLE IF NOT EXISTS schema_migrations (
    version    TEXT PRIMARY KEY,
    applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
  )
`);

const applied = new Set(
  (await pool.query<{ version: string }>("SELECT version FROM schema_migrations")).rows.map(
    (row) => row.version,
  ),
);

const files = (await readdir(dir)).filter((name) => name.endsWith(".sql")).sort();
let count = 0;

for (const file of files) {
  const version = file.replace(/\.sql$/, "");
  if (applied.has(version)) continue;

  const sql = await readFile(join(dir, file), "utf8");
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(sql);
    await client.query("INSERT INTO schema_migrations (version) VALUES ($1)", [version]);
    await client.query("COMMIT");
    console.log(`applied ${version}`);
    count++;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    console.error(`failed on ${version}:`, error);
    process.exit(1);
  } finally {
    client.release();
  }
}

/**
 * The disposable stamp, written ONLY on the --test path.
 *
 * WHY IT IS NOT A MIGRATION, and this is the point: a migration runs against
 * every database, production included, which is exactly backwards. This is a
 * mark of ENVIRONMENT, not of schema — it says "this database is meant to be
 * truncated" — and the whole value of it is that production can never carry
 * it. Moving it into `migrations/` would look tidier and would silently
 * destroy the guarantee.
 *
 * WHAT IT REPLACES. `vitest.setup.ts` asked "is TEST the same as APP", which
 * is a relative question with a hole in it: with DATABASE_URL unset the
 * comparison passes and the suite truncates whatever TEST_DATABASE_URL
 * happens to be — production included. Two wars titled "Fixture war" were
 * found sitting in this project's production database, created after that
 * guard already existed, which is what sent somebody looking.
 *
 * The stamp makes the question absolute: the database itself says whether it
 * is disposable, and no combination of environment variables can fake it.
 */
if (useTest) {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS disposable_database (
      stamped_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      note       TEXT        NOT NULL
    )
  `);
  await pool.query(
    `INSERT INTO disposable_database (note)
     SELECT $1 WHERE NOT EXISTS (SELECT 1 FROM disposable_database)`,
    ["Truncated between tests. Never point this at a database with real data."],
  );
  console.log("stamped as disposable");
}

console.log(count === 0 ? "nothing to apply" : `applied ${count} migration(s)`);
await pool.end();

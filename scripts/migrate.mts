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

console.log(count === 0 ? "nothing to apply" : `applied ${count} migration(s)`);
await pool.end();

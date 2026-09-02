import { config } from "dotenv";
import { Pool } from "pg";

/**
 * What version of the schema each database is actually at.
 *
 * **Why this exists.** On 2026-09-02 a batch added `007_listing_attempts`, ran
 * `db:migrate:test`, and closed. The preview database had never been migrated,
 * so the first request to the new route on the preview deployment answered
 * `500` — `relation "listing_attempts" does not exist`. The suite was green,
 * the local database was right, and nothing in the close asked the other two
 * databases anything. `~/.claude/GATES.md` has the incident.
 *
 * A migration is not applied until every database this repository can name has
 * it. This is the check that says so, and it answers rather than guessing: a
 * target that cannot be read is reported as UNKNOWN and fails the run, because
 * "could not connect" and "up to date" must never look the same.
 *
 * WHO CALLS THIS: `/cierre`, before the push, whenever a batch adds a
 * migration. Run it by hand any time: `npx tsx scripts/schema-versions.mts`.
 */

config({ path: ".env.local" });

/**
 * Every database this repository knows how to migrate, in the order a close
 * applies them: the disposable one first, the shared one last.
 */
const TARGETS: [name: string, variable: string][] = [
  ["test", "TEST_DATABASE_URL"],
  ["preview", "PREVIEW_DATABASE_URL"],
  ["production", "DATABASE_URL"],
];

type Reading =
  | { name: string; state: "ok"; version: string; applied: number; host: string }
  | { name: string; state: "unset" }
  | { name: string; state: "unknown"; why: string };

async function read(name: string, url: string): Promise<Reading> {
  const pool = new Pool({ connectionString: url, max: 1 });
  try {
    const { rows } = await pool.query<{ version: string | null; applied: string }>(
      "SELECT max(version) AS version, count(*) AS applied FROM schema_migrations",
    );
    return {
      name,
      state: "ok",
      version: rows[0]?.version ?? "(none applied)",
      applied: Number(rows[0]?.applied ?? 0),
      host: new URL(url).hostname,
    };
  } catch (error) {
    // The NAME, never the object: a rejected connection carries the URL it was
    // given, and that URL has a password in it.
    return { name, state: "unknown", why: error instanceof Error ? error.name : "unknown" };
  } finally {
    await pool.end().catch(() => {});
  }
}

const readings: Reading[] = [];
for (const [name, variable] of TARGETS) {
  const url = process.env[variable]?.trim();
  readings.push(url ? await read(name, url) : { name, state: "unset" });
}

for (const r of readings) {
  if (r.state === "ok") console.log(`${r.name.padEnd(11)} ${r.version}  (${r.applied} applied)  @ ${r.host}`);
  else if (r.state === "unset") console.log(`${r.name.padEnd(11)} not configured in this environment`);
  else console.log(`${r.name.padEnd(11)} UNKNOWN — could not be read (${r.why})`);
}

const unknown = readings.filter((r) => r.state === "unknown");
if (unknown.length > 0) {
  console.log(`\nFAIL: ${unknown.map((r) => r.name).join(", ")} could not be read, so this check does not know.`);
  process.exit(1);
}

const known = readings.filter((r): r is Extract<Reading, { state: "ok" }> => r.state === "ok");
if (known.length < 2) {
  // One database is not a comparison. Saying "they agree" here would be a pass
  // that measured nothing, which is the shape the incident took.
  console.log("\nFAIL: fewer than two databases are configured here, so nothing was compared.");
  process.exit(1);
}

const versions = new Set(known.map((r) => r.version));
if (versions.size > 1) {
  console.log(`\nFAIL: the databases are at different versions — ${[...versions].join(" vs ")}.`);
  process.exit(1);
}

console.log(`\nOK: ${known.map((r) => r.name).join(", ")} are all at ${known[0]!.version}.`);

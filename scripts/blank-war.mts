import { config } from "dotenv";
import { Pool } from "pg";

/**
 * Empties one war's board, keeping the war and its tokens.
 *
 * WHY A SCRIPT RATHER THAN A MIGRATION. This is data, not schema, and it is
 * true of exactly one deployment's exactly one war. A migration would run
 * against every database that ever applies it — including a future one where
 * `demo` means something else — and migrations are frozen once applied, so a
 * mistake here would be permanent. A script is re-runnable, takes its target
 * as an argument, and leaves no trace in the schema history it does not
 * belong in.
 *
 * WHAT IT DOES NOT TOUCH: `wars.last_seq`. That counter is documented as
 * monotonic and gapless (migration 001) because clients hold a sequence and
 * ask for everything after it; winding it back would make an open tab's
 * sequence higher than the server's, and `changesSince` answers "you have
 * nothing to learn" to exactly that — so the tab would keep showing the
 * pixels this just deleted, forever, with no resync to rescue it. Leaving the
 * counter alone costs one honest thing instead: a tab that was open across
 * the wipe shows a stale board until it is reloaded. Nobody is watching a
 * pre-launch board, and a reload is a cheaper price than an unrecoverable
 * client.
 *
 *   npx tsx scripts/blank-war.mts <slug>
 */

config({ path: ".env.local" });

const slug = process.argv[2];
if (!slug) {
  console.error("usage: tsx scripts/blank-war.mts <war-slug>");
  process.exit(1);
}

const url = process.env.DATABASE_URL;
if (!url) {
  console.error("DATABASE_URL is not set. There is no default: a fallback would mean blanking the wrong database.");
  process.exit(1);
}

const pool = new Pool({ connectionString: url });

const war = (
  await pool.query<{ id: string; title: string }>(`SELECT id, title FROM wars WHERE slug = $1`, [slug])
).rows[0];

if (!war) {
  console.error(`No war with slug "${slug}".`);
  await pool.end();
  process.exit(1);
}

const before = (
  await pool.query<{ pixels: string; events: string }>(
    `SELECT (SELECT count(*) FROM pixels WHERE war_id = $1)       AS pixels,
            (SELECT count(*) FROM pixel_events WHERE war_id = $1) AS events`,
    [war.id],
  )
).rows[0];

console.log(`${slug} (${war.title}): ${before.pixels} pixels, ${before.events} events`);

const client = await pool.connect();
try {
  await client.query("BEGIN");
  await client.query(`DELETE FROM pixels WHERE war_id = $1`, [war.id]);
  await client.query(`DELETE FROM pixel_events WHERE war_id = $1`, [war.id]);
  // Zeroed rather than deleted: the leaderboard LEFT JOINs these, so a
  // missing row and a zeroed row render identically — but a zeroed row keeps
  // the token's place in the table for the next paint to increment.
  await client.query(
    `UPDATE token_pixel_counts SET owned = 0, placed = 0 WHERE war_id = $1`,
    [war.id],
  );
  await client.query("COMMIT");
} catch (error) {
  await client.query("ROLLBACK").catch(() => {});
  console.error("failed, nothing was deleted:", error);
  process.exit(1);
} finally {
  client.release();
}

const after = (
  await pool.query<{ pixels: string; events: string }>(
    `SELECT (SELECT count(*) FROM pixels WHERE war_id = $1)       AS pixels,
            (SELECT count(*) FROM pixel_events WHERE war_id = $1) AS events`,
    [war.id],
  )
).rows[0];

console.log(`blanked. now ${after.pixels} pixels, ${after.events} events`);
await pool.end();

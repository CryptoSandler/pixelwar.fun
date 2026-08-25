import { randomUUID } from "node:crypto";
import { config } from "dotenv";
import { Pool } from "pg";

/**
 * A war to develop against.
 *
 * Development only, and it says so out loud rather than trusting the operator
 * to notice: a seeded war carries fake tokens that never paid, and a fake
 * token on the production board is a lie about who is in a war people paid to
 * enter.
 */

if (process.env.NODE_ENV === "production") {
  console.error("Refusing to seed: NODE_ENV is production.");
  process.exit(1);
}

config({ path: ".env.local" });

const url = process.env.DATABASE_URL;
if (!url) {
  console.error("DATABASE_URL is not set.");
  process.exit(1);
}

const TOKENS = [
  { ticker: "PEPE", name: "Pepe", slot: 6 },
  { ticker: "WIF", name: "dogwifhat", slot: 13 },
  { ticker: "BONK", name: "Bonk", slot: 3 },
  { ticker: "MOG", name: "Mog Coin", slot: 18 },
  { ticker: "POPCAT", name: "Popcat", slot: 2 },
  { ticker: "GIGA", name: "Gigachad", slot: 24 },
];

const pool = new Pool({ connectionString: url });
const warId = randomUUID();

await pool.query(
  `INSERT INTO wars (id, slug, title, status, entry_price_usd, cooldown_seconds, starts_at, ends_at)
   VALUES ($1, 'demo', 'Demo war', 'live', 25, 5, now() - interval '1 hour', now() + interval '48 hours')
   ON CONFLICT (slug) DO NOTHING`,
  [warId],
);

const { rows } = await pool.query<{ id: string }>(`SELECT id FROM wars WHERE slug = 'demo'`);
const id = rows[0].id;

for (const token of TOKENS) {
  const tokenId = randomUUID();
  await pool.query(
    `INSERT INTO war_tokens (id, war_id, chain_id, contract, contract_key, colour_slot, status,
                             name, ticker, metadata_fetched_at, reserved_at, joined_at)
     VALUES ($1, $2, 'solana', $3, $3, $4, 'active', $5, $6, now(), now(), now())
     ON CONFLICT DO NOTHING`,
    [tokenId, id, `demo-${token.ticker}`, token.slot, token.name, token.ticker],
  );
  await pool.query(
    `INSERT INTO token_pixel_counts (war_id, war_token_id)
     SELECT $1, id FROM war_tokens WHERE war_id = $1 AND contract_key = $2
     ON CONFLICT DO NOTHING`,
    [id, `demo-${token.ticker}`],
  );
}

console.log(`Seeded war 'demo' with ${TOKENS.length} tokens. Cooldown is 5 seconds.`);
await pool.end();

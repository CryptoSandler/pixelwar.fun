import { randomBytes, randomUUID } from "node:crypto";
import { execute } from "../../db";
import { base58Encode } from "../../base58";
import { issuePainter, PAINTER_COOKIE } from "../../paint/painter";
import { warById } from "../../wars/lifecycle";
import type { War } from "../../wars/lifecycle";

export async function makeWar(overrides: Partial<{ width: number; height: number; cooldownSeconds: number; status: string; startsAt: Date; endsAt: Date }> = {}): Promise<War> {
  const id = randomUUID();
  await execute(
    `INSERT INTO wars (id, slug, title, status, width, height, entry_price_usd, cooldown_seconds, starts_at, ends_at)
     VALUES ($1, $1, 'Fixture war', $2, $3, $4, 25, $5, $6, $7)`,
    [
      id,
      overrides.status ?? "live",
      overrides.width ?? 8,
      overrides.height ?? 8,
      overrides.cooldownSeconds ?? 30,
      overrides.startsAt ?? new Date(Date.now() - 3_600_000),
      overrides.endsAt ?? new Date(Date.now() + 3_600_000),
    ],
  );
  return (await warById(id))!;
}

export async function makeToken(warId: string, colourSlot: number): Promise<string> {
  const id = randomUUID();
  await execute(
    `INSERT INTO war_tokens (id, war_id, chain_id, contract, contract_key, colour_slot, status,
                             name, ticker, metadata_fetched_at, reserved_at, joined_at)
     VALUES ($1, $2, 'solana', $1, $1, $3, 'active', $4, $4, now(), now(), now())`,
    [id, warId, colourSlot, `T${colourSlot}`],
  );
  await execute(
    `INSERT INTO token_pixel_counts (war_id, war_token_id) VALUES ($1, $2)`,
    [warId, id],
  );
  return id;
}

/**
 * Writes a pixel straight to the tables, bypassing every rule. Fixtures only.
 *
 * `tokenId` and `colourSlot` are independent arguments and callers should
 * treat them that way: since the free-palette change they are two different
 * facts about a pixel, and a fixture that always passes the token's own slot
 * as the colour can only exercise the case where they coincide.
 */
export async function paintRaw(
  warId: string,
  idx: number,
  tokenId: string,
  colourSlot: number,
  seq: number,
): Promise<void> {
  await execute(
    `INSERT INTO pixels (war_id, idx, war_token_id, colour_slot, seq, painted_at)
     VALUES ($1, $2, $3, $4, $5, now())
     ON CONFLICT (war_id, idx) DO UPDATE
       SET war_token_id = $3, colour_slot = $4, seq = $5, painted_at = now()`,
    [warId, idx, tokenId, colourSlot, seq],
  );
  await execute(
    `INSERT INTO pixel_events (war_id, seq, idx, colour_slot, war_token_id, painted_at)
     VALUES ($1, $2, $3, $4, $5, now())`,
    [warId, seq, idx, colourSlot, tokenId],
  );
  await execute(`UPDATE wars SET last_seq = GREATEST(last_seq, $2) WHERE id = $1`, [warId, seq]);
}

/**
 * An address a Solana address validator accepts: 32 bytes, base58.
 *
 * Random bytes rather than a generated key pair, because nothing here signs
 * anything — but it has to be a REAL address shape, since `linkWallet` and
 * `register` both run it through the same validator every user-supplied
 * address goes through, and a plausible-looking string that is not 32 bytes
 * is rejected there.
 */
function fakeWallet(): string {
  return base58Encode(new Uint8Array(randomBytes(32)));
}

/**
 * Makes a painter key one that may paint: a registration, and a link to it.
 *
 * Since migration 012 painting requires both, so almost every fixture that
 * paints needs this. It writes the two rows directly rather than going
 * through `register`, for the reason `paintRaw` bypasses `paintPixel`: the
 * fixture's job is to arrange the world, and arranging it through the code
 * under test would make a broken gate look like a passing suite.
 */
export async function registerPainter(painterKey: string): Promise<string> {
  const wallet = fakeWallet();
  await execute(
    `INSERT INTO registrations (wallet, signature, lamports) VALUES ($1, $2, 3000000)`,
    [wallet, `fixture-${randomUUID()}`],
  );
  await execute(
    `INSERT INTO painter_wallets (painter_key, wallet) VALUES ($1, $2)
     ON CONFLICT (painter_key) DO UPDATE SET wallet = EXCLUDED.wallet`,
    [painterKey, wallet],
  );
  return wallet;
}

/**
 * A registered painter's cookie, for tests that go through a route.
 *
 * A route mints a painter key from the cookie it is handed, so a fixture
 * cannot register a caller it has not identified first. This issues the
 * cookie and registers the key behind it, which is the only order that works
 * — and gives each call a DISTINCT painter, so a test that needs two people
 * gets two.
 */
export async function registeredPainter(): Promise<{
  cookie: string;
  painterKey: string;
  wallet: string;
}> {
  const { cookieValue, painterKey } = issuePainter();
  const wallet = await registerPainter(painterKey);
  return { cookie: `${PAINTER_COOKIE}=${cookieValue}`, painterKey, wallet };
}

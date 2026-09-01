import type { PoolClient } from "pg";
import { sidesLockMinutes, subnetBurst } from "../config";
import { transaction } from "../db";
import type { War } from "../wars/lifecycle";
import { PALETTE_SIZE } from "../wars/palette";
import { isBanned } from "./bans";
import { paintingWallet } from "./registration";

/**
 * One pixel, one transaction.
 *
 * Everything that decides whether a paint is allowed happens inside it: the
 * war's own clock, the bans, the cooldowns, the sequence allocation and the
 * counts. Any check made outside is a check a second request can race past.
 */

export type PaintFailure =
  | "war_not_live"
  | "war_not_started"
  | "out_of_bounds"
  | "unknown_token"
  | "unknown_colour"
  | "wrong_allegiance"
  | "sides_locked"
  | "banned"
  | "not_registered"
  | "cooldown";

export type PaintResult =
  | {
      ok: true;
      seq: number;
      idx: number;
      colourSlot: number;
      cooldownUntil: string;
      /** The token this painter now fights for, whether it was just decided or already was. */
      allegianceTokenId: string;
    }
  | { ok: false; reason: PaintFailure; message: string; retryAfterSeconds?: number };

export type PaintInput = {
  war: War;
  x: number;
  y: number;
  /**
   * The token this paint is ATTRIBUTED to — who the painter is playing for.
   * No longer has anything to do with what colour lands on the board.
   */
  tokenId: string;
  /**
   * The colour to paint, 1..PALETTE_SIZE, chosen freely by the painter.
   *
   * Validated here rather than trusted from the route, because this is the
   * trust boundary that matters: a slot outside the palette reaches the
   * canvas as a byte no client can render, and 0 would mean "unpainted" — a
   * caller could erase somebody else's pixel by painting the ground colour.
   */
  colourSlot: number;
  painterKey: string;
  ipHash: string;
  subnetKey: string;
};

/** A gate either lets the caller through, or reports how long until it won't refuse them. */
type Gate = { ok: true } | { ok: false; waitSeconds: number };

function waitFrom(seconds: unknown): number {
  return Math.max(1, Math.ceil(Number(seconds ?? 1)));
}

/**
 * Takes one cooldown key. Reports how long the caller must wait when refused.
 *
 * The condition lives in the UPDATE's WHERE clause rather than in a SELECT
 * followed by an UPDATE, so two concurrent paints cannot both read "clear" and
 * both proceed — the second one updates zero rows and loses.
 *
 * On refusal, the wait is read back from the row that just blocked the
 * UPDATE — not computed as a separate "when is this caller free" query. This
 * transaction is about to roll back, so any row it inserted itself (a brand
 * new painter's first-ever cooldown row, for instance) will not exist once
 * committed; asking a fresh question here would read the transaction's own
 * doomed write instead of the state the next attempt will actually see.
 */
async function takeInterval(
  client: PoolClient,
  warId: string,
  keyType: "painter" | "ip",
  key: string,
  seconds: number,
): Promise<Gate> {
  const result = await client.query(
    `INSERT INTO paint_cooldowns AS c (war_id, key_type, key, last_painted_at, window_start, window_count)
     VALUES ($1, $2, $3, now(), now(), 1)
     ON CONFLICT (war_id, key_type, key) DO UPDATE
       SET last_painted_at = now(), window_count = c.window_count + 1
       WHERE c.last_painted_at <= now() - ($4 || ' seconds')::interval
     RETURNING last_painted_at`,
    [warId, keyType, key, String(seconds)],
  );
  if ((result.rowCount ?? 0) > 0) return { ok: true };

  const blocking = await client.query<{ wait: string }>(
    `SELECT EXTRACT(EPOCH FROM (last_painted_at + ($4 || ' seconds')::interval - now())) AS wait
       FROM paint_cooldowns
      WHERE war_id = $1 AND key_type = $2 AND key = $3`,
    [warId, keyType, key, String(seconds)],
  );
  return { ok: false, waitSeconds: waitFrom(blocking.rows[0]?.wait) };
}

/**
 * The subnet key is gated on a count per window, not on an interval.
 *
 * Same reasoning as `takeInterval` for why the wait is read from the blocking
 * row rather than asked separately: a subnet's clock is the window rolling
 * over, not any one painter's cooldown, and the row that answers that
 * question is the one the UPDATE just failed to touch.
 */
async function takeBurst(client: PoolClient, warId: string, key: string): Promise<Gate> {
  const { cap, windowSeconds } = subnetBurst();
  const result = await client.query(
    `INSERT INTO paint_cooldowns AS c (war_id, key_type, key, last_painted_at, window_start, window_count)
     VALUES ($1, 'subnet', $2, now(), now(), 1)
     ON CONFLICT (war_id, key_type, key) DO UPDATE
       SET last_painted_at = now(),
           window_start = CASE WHEN c.window_start <= now() - ($3 || ' seconds')::interval
                               THEN now() ELSE c.window_start END,
           window_count = CASE WHEN c.window_start <= now() - ($3 || ' seconds')::interval
                               THEN 1 ELSE c.window_count + 1 END
       WHERE c.window_start <= now() - ($3 || ' seconds')::interval OR c.window_count < $4
     RETURNING window_count`,
    [warId, key, String(windowSeconds), cap],
  );
  if ((result.rowCount ?? 0) > 0) return { ok: true };

  const blocking = await client.query<{ wait: string }>(
    `SELECT EXTRACT(EPOCH FROM (window_start + ($3 || ' seconds')::interval - now())) AS wait
       FROM paint_cooldowns
      WHERE war_id = $1 AND key_type = 'subnet' AND key = $2`,
    [warId, key, String(windowSeconds)],
  );
  return { ok: false, waitSeconds: waitFrom(blocking.rows[0]?.wait) };
}

export async function paintPixel(input: PaintInput): Promise<PaintResult> {
  const { war, x, y, tokenId, colourSlot, painterKey, ipHash, subnetKey } = input;

  if (
    !Number.isInteger(x) ||
    !Number.isInteger(y) ||
    x < 0 ||
    y < 0 ||
    x >= war.width ||
    y >= war.height
  ) {
    return { ok: false, reason: "out_of_bounds", message: "That pixel is not on the board." };
  }

  // Slot 0 is the unpainted ground and is deliberately not paintable: it is
  // the one value that would let a caller blank a pixel rather than take it,
  // which is erasure dressed up as painting and is not a move this game has.
  if (!Number.isInteger(colourSlot) || colourSlot < 1 || colourSlot > PALETTE_SIZE) {
    return {
      ok: false,
      reason: "unknown_colour",
      message: "That colour is not on the palette.",
    };
  }

  const idx = y * war.width + x;

  return transaction(async (client) => {
    // The war's own clock, read inside the transaction: a war that has not
    // started yet, or that ended while the request was in flight, must not
    // accept this paint. Checked as two separate wall-clock comparisons
    // rather than folded into one "not live" answer, because "come back
    // later" and "this is over" are different messages to a caller.
    //
    // `sides_locked` is derived here, from the same clock and in the same
    // read, for the reason CLAUDE.md gives: a status is never an input. "The
    // last window" is `now() >= ends_at - N`, and the moment it becomes a
    // column an operator sets, an operator can put a war into a last window
    // its own deadline contradicts.
    const lockMinutes = sidesLockMinutes();
    const warRow = await client.query<{
      status: string;
      not_started: boolean;
      ended: boolean;
      sides_locked: boolean;
      cooldown_seconds: number;
    }>(
      `SELECT status, (starts_at > now()) AS not_started, (ends_at <= now()) AS ended,
              (ends_at <= now() + ($2 || ' minutes')::interval) AS sides_locked,
              cooldown_seconds
         FROM wars WHERE id = $1`,
      [war.id, String(lockMinutes)],
    );
    const current = warRow.rows[0];
    if (!current) {
      return {
        ok: false as const,
        reason: "war_not_live" as const,
        message: "This war is not accepting pixels.",
      };
    }
    if (current.not_started) {
      return {
        ok: false as const,
        reason: "war_not_started" as const,
        message: "This war has not started yet.",
      };
    }
    if (current.status !== "live" || current.ended) {
      return {
        ok: false as const,
        reason: "war_not_live" as const,
        message: "This war is not accepting pixels.",
      };
    }

    if (await isBanned(client, { warId: war.id, painterKey, ipHash, subnetKey })) {
      return {
        ok: false as const,
        reason: "banned" as const,
        message: "You cannot paint in this war.",
      };
    }

    // THE REGISTRATION GATE. After the ban and before anything is written.
    //
    // AFTER THE BAN on purpose: a banned caller is told they cannot paint,
    // not invited to go and pay for the privilege first. Taking a fee from
    // somebody the board has already refused would be taking money for
    // nothing, and it would also be a way for a ban to generate revenue,
    // which is a thing nobody should ever be able to say about this.
    //
    // INSIDE THE TRANSACTION for the reason at the top of this file: a check
    // made outside is a check a second request races past. It reads one row
    // and it happens before the `last_seq` lock, so it costs nothing at the
    // ceiling the load test found.
    const wallet = await paintingWallet(client, painterKey);
    if (!wallet) {
      return {
        ok: false as const,
        reason: "not_registered" as const,
        // The screen turns this into the registration flow. The message says
        // what is missing and not what it costs — the price lives in one
        // place, and a stale price quoted from here would be a lie about
        // money.
        message: "Painting needs a registered wallet.",
      };
    }

    // Still checked, and still required — but only to establish that this is a
    // token somebody may play for. What colour the paint lands in is the
    // painter's choice and was settled above.
    const token = await client.query<{ id: string }>(
      `SELECT id FROM war_tokens
        WHERE id = $1 AND war_id = $2 AND status = 'active'`,
      [tokenId, war.id],
    );
    if (token.rowCount === 0) {
      return {
        ok: false as const,
        reason: "unknown_token" as const,
        message: "That token is not in this war.",
      };
    }

    // ALLEGIANCE. The first pixel of a war commits this painter to one token
    // for the rest of it, and every pixel after that has to agree.
    //
    // Written as INSERT ... ON CONFLICT DO NOTHING RETURNING rather than
    // SELECT-then-INSERT, because those two are a race: two paints arriving
    // together would both find no row and both insert, and only the unique
    // index would notice — as an error, on the paint that had done nothing
    // wrong. One statement decides it, and the empty result IS the answer
    // "somebody already did".
    const claimed = await client.query<{ war_token_id: string }>(
      `INSERT INTO war_painters (war_id, painter_key, war_token_id)
       VALUES ($1, $2, $3)
       ON CONFLICT (war_id, painter_key) DO NOTHING
       RETURNING war_token_id`,
      [war.id, painterKey, tokenId],
    );

    // THE LAST WINDOW CLOSES THE SIDES, AND THE INSERT ABOVE IS WHAT KNOWS.
    //
    // A returned row means the conflict did not fire, which means this
    // painter had no allegiance a moment ago — they are joining this war for
    // the first time, right now. That is the one act the last window forbids;
    // everybody who already picked a side goes on painting untouched.
    //
    // WHY THE SCARCITY IS HERE AND NOT ON PAINT ITSELF. Every mechanic that
    // makes the final minutes worth more concentrates writes at the moment
    // concurrency peaks, and `docs/operations.md` measures what that costs:
    // one row lock on `wars` held for five round trips, `1 / (5 x round-trip
    // time)`, "nothing about connection pools, instance count or CPU changes
    // it". This rule can only ever turn a paint into a refusal, so it cannot
    // raise the rate under any input — and it refuses HERE, above the
    // `last_seq` update, so it never queues behind that lock either.
    // `sides-lock.test.ts` asserts the sequence does not move.
    //
    // IT THROWS RATHER THAN RETURNS, exactly as the cooldown gates below do
    // and for the same reason: the allegiance row is already inserted, and a
    // plain return would COMMIT the very side this rule just refused.
    if (lockMinutes > 0 && current.sides_locked && claimed.rows[0]) {
      throw new SidesLockedError(lockMinutes);
    }

    let allegiance = claimed.rows[0]?.war_token_id;
    if (!allegiance) {
      const existing = await client.query<{ war_token_id: string }>(
        `SELECT war_token_id FROM war_painters WHERE war_id = $1 AND painter_key = $2`,
        [war.id, painterKey],
      );
      allegiance = existing.rows[0]?.war_token_id;
    }

    if (allegiance && allegiance !== tokenId) {
      const sworn = await client.query<{ ticker: string }>(
        `SELECT ticker FROM war_tokens WHERE id = $1`,
        [allegiance],
      );
      return {
        ok: false as const,
        reason: "wrong_allegiance" as const,
        // Names the side rather than scolding. And says "this war", never
        // "permanent" — the lock is soft and copy claiming otherwise would
        // be the application lying about itself.
        message: `You fight for ${sworn.rows[0]?.ticker ?? "another token"} this war.`,
      };
    }

    // Always painter, then ip, then subnet. A fixed order means two concurrent
    // paints can never hold one key each and wait on the other. Each gate
    // carries its own wait — a painter cooldown and a subnet window are
    // different clocks, and reporting the wrong one tells a caller behind an
    // already-capped subnet to come back in seconds when the real wait is the
    // rest of the window.
    const cooldown = current.cooldown_seconds;

    const painterGate = await takeInterval(client, war.id, "painter", painterKey, cooldown);
    if (!painterGate.ok) throw new CooldownError(painterGate.waitSeconds);

    const ipGate = await takeInterval(client, war.id, "ip", ipHash, cooldown);
    if (!ipGate.ok) throw new CooldownError(ipGate.waitSeconds);

    const subnetGate = await takeBurst(client, war.id, subnetKey);
    if (!subnetGate.ok) throw new CooldownError(subnetGate.waitSeconds);
    // Roll back on any of the above: a refused paint must not leave a
    // half-taken cooldown behind.

    const seqRow = await client.query<{ last_seq: string }>(
      `UPDATE wars SET last_seq = last_seq + 1 WHERE id = $1 RETURNING last_seq`,
      [war.id],
    );
    const seq = Number(seqRow.rows[0].last_seq);

    const previous = await client.query<{ war_token_id: string }>(
      `SELECT war_token_id FROM pixels WHERE war_id = $1 AND idx = $2`,
      [war.id, idx],
    );

    await client.query(
      `INSERT INTO pixels (war_id, idx, war_token_id, colour_slot, seq, painted_at, painter_key, ip_hash)
       VALUES ($1, $2, $3, $7, $4, now(), $5, $6)
       ON CONFLICT (war_id, idx) DO UPDATE
         SET war_token_id = $3, colour_slot = $7, seq = $4, painted_at = now(),
             painter_key = $5, ip_hash = $6`,
      [war.id, idx, tokenId, seq, painterKey, ipHash, colourSlot],
    );

    await client.query(
      `INSERT INTO pixel_events (war_id, seq, idx, colour_slot, war_token_id, painted_at)
       VALUES ($1, $2, $3, $4, $5, now())`,
      [war.id, seq, idx, colourSlot, tokenId],
    );

    const previousOwner = previous.rows[0]?.war_token_id;
    if (previousOwner && previousOwner !== tokenId) {
      await client.query(
        `UPDATE token_pixel_counts SET owned = GREATEST(0, owned - 1)
          WHERE war_id = $1 AND war_token_id = $2`,
        [war.id, previousOwner],
      );
    }

    await client.query(
      `INSERT INTO token_pixel_counts (war_id, war_token_id, owned, placed)
       VALUES ($1, $2, 1, 1)
       ON CONFLICT (war_id, war_token_id) DO UPDATE
         SET owned = token_pixel_counts.owned + $3, placed = token_pixel_counts.placed + 1`,
      [war.id, tokenId, previousOwner === tokenId ? 0 : 1],
    );

    return {
      ok: true as const,
      seq,
      idx,
      colourSlot,
      cooldownUntil: new Date(Date.now() + cooldown * 1000).toISOString(),
      allegianceTokenId: allegiance ?? tokenId,
    };
  }).catch((error: unknown) => {
    if (error instanceof CooldownError) {
      return {
        ok: false as const,
        reason: "cooldown" as const,
        retryAfterSeconds: error.retryAfterSeconds,
        message: `Wait ${error.retryAfterSeconds} second${error.retryAfterSeconds === 1 ? "" : "s"} before painting again.`,
      };
    }
    if (error instanceof SidesLockedError) {
      return {
        ok: false as const,
        reason: "sides_locked" as const,
        // States the rule and its size, and stops. No scolding, and nothing
        // about being too late — the same discipline `wrong_allegiance` is
        // held to. It also does not promise this is how wars work: it says
        // "this war", because whether the next one closes its sides is an
        // operator's setting and copy must not claim otherwise.
        message:
          `Sides closed for the last ${error.lockMinutes} minutes of this war. ` +
          `This one is fought with the armies it has.`,
      };
    }
    throw error;
  });
}

/** Thrown to roll the transaction back; translated to a result by the caller. */
class CooldownError extends Error {
  constructor(readonly retryAfterSeconds: number) {
    super("cooldown");
    this.name = "CooldownError";
  }
}

/**
 * Thrown for the same reason `CooldownError` is, and it matters more here.
 *
 * By the time this fires, `war_painters` already holds the row that says this
 * painter joined — the INSERT is how the rule knows they are new. Returning a
 * result would commit it, and the next paint would sail through against an
 * allegiance the last window had already refused.
 */
class SidesLockedError extends Error {
  constructor(readonly lockMinutes: number) {
    super("sides_locked");
    this.name = "SidesLockedError";
  }
}

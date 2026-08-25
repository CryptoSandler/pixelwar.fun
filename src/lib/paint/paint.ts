import type { PoolClient } from "pg";
import { subnetBurst } from "../config";
import { transaction } from "../db";
import type { War } from "../wars/lifecycle";
import { isBanned } from "./bans";

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
  | "banned"
  | "cooldown";

export type PaintResult =
  | { ok: true; seq: number; idx: number; colourSlot: number; cooldownUntil: string }
  | { ok: false; reason: PaintFailure; message: string; retryAfterSeconds?: number };

export type PaintInput = {
  war: War;
  x: number;
  y: number;
  tokenId: string;
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
  const { war, x, y, tokenId, painterKey, ipHash, subnetKey } = input;

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

  const idx = y * war.width + x;

  return transaction(async (client) => {
    // The war's own clock, read inside the transaction: a war that has not
    // started yet, or that ended while the request was in flight, must not
    // accept this paint. Checked as two separate wall-clock comparisons
    // rather than folded into one "not live" answer, because "come back
    // later" and "this is over" are different messages to a caller.
    const warRow = await client.query<{
      status: string;
      not_started: boolean;
      ended: boolean;
      cooldown_seconds: number;
    }>(
      `SELECT status, (starts_at > now()) AS not_started, (ends_at <= now()) AS ended, cooldown_seconds
         FROM wars WHERE id = $1`,
      [war.id],
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

    if (await isBanned(client, { painterKey, ipHash, subnetKey })) {
      return {
        ok: false as const,
        reason: "banned" as const,
        message: "You cannot paint in this war.",
      };
    }

    const token = await client.query<{ colour_slot: number }>(
      `SELECT colour_slot FROM war_tokens
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
    const colourSlot = token.rows[0].colour_slot;

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
      `INSERT INTO pixels (war_id, idx, war_token_id, seq, painted_at, painter_key, ip_hash)
       VALUES ($1, $2, $3, $4, now(), $5, $6)
       ON CONFLICT (war_id, idx) DO UPDATE
         SET war_token_id = $3, seq = $4, painted_at = now(), painter_key = $5, ip_hash = $6`,
      [war.id, idx, tokenId, seq, painterKey, ipHash],
    );

    await client.query(
      `INSERT INTO pixel_events (war_id, seq, idx, colour_slot, painted_at)
       VALUES ($1, $2, $3, $4, now())`,
      [war.id, seq, idx, colourSlot],
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

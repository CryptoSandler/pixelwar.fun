import { execute, query, queryOne, transaction } from "./db";

/**
 * The operator's emergency kit.
 *
 * WHY THIS EXISTS AND WHY IT IS FIRST. Of everything a public canvas needs,
 * moderation is the only piece that cannot be added late. The gap between
 * "first visitor" and "first swastika" is measured in hours, and a moderation
 * panel written while the site is on fire is worse than one written with no
 * data. Everything else in the launch plan tolerates arriving after launch;
 * this does not.
 *
 * WHAT WAS ALREADY HERE. Almost all of it. `bans` has carried the right shape
 * since migration 001 — three key types, a reason, an actor, an optional
 * expiry, a unique index — and `isBanned` has been consulted by `paintPixel`
 * before it writes anything, all along. Nothing in this file is a new
 * mechanism. What was missing was any way to write a row.
 */

export type BanKeyType = "painter" | "ip" | "subnet";

export type Ban = {
  id: string;
  keyType: BanKeyType;
  key: string;
  reason: string | null;
  actor: string;
  createdAt: Date;
  expiresAt: Date | null;
};

type BanRow = {
  id: string;
  key_type: BanKeyType;
  key: string;
  reason: string | null;
  actor: string;
  created_at: Date;
  expires_at: Date | null;
};

function toBan(row: BanRow): Ban {
  return {
    id: row.id,
    keyType: row.key_type,
    key: row.key,
    reason: row.reason,
    actor: row.actor,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
  };
}

/**
 * Bans a key, or moves an existing ban's expiry and reason.
 *
 * UPSERT rather than INSERT, because `bans_key` is unique on
 * `(key_type, key)` and the operator's second action on a repeat offender is
 * "make that longer", not "fail with a constraint violation". The actor is
 * overwritten too: the person who last decided is the person answerable for
 * the current state of the ban.
 *
 * EXPIRY IS THE CALLER'S, AND THE DEFAULT IS TEMPORARY. `expiresAt` of `null`
 * means no expiry, and this function will happily write it — the mechanism
 * supports both futures on purpose. Which one the product chooses is a policy
 * question recorded in `docs/operations.md` as the owner's open decision, and
 * deliberately not settled here: a permanent ban is an irreversible sentence,
 * and nothing in this codebase's copy promises one.
 */
export async function banKey(input: {
  keyType: BanKeyType;
  key: string;
  reason: string | null;
  actor: string;
  expiresAt: Date | null;
}): Promise<Ban> {
  const row = await queryOne<BanRow>(
    `INSERT INTO bans (id, key_type, key, reason, actor, expires_at)
     VALUES (gen_random_uuid()::text, $1, $2, $3, $4, $5)
     ON CONFLICT (key_type, key) DO UPDATE
       SET reason = EXCLUDED.reason,
           actor = EXCLUDED.actor,
           expires_at = EXCLUDED.expires_at,
           created_at = now()
     RETURNING id, key_type, key, reason, actor, created_at, expires_at`,
    [input.keyType, input.key, input.reason, input.actor, input.expiresAt],
  );
  return toBan(row!);
}

/** Lifts a ban outright. Returns false when there was nothing to lift. */
export async function liftBan(id: string): Promise<boolean> {
  return (await execute(`DELETE FROM bans WHERE id = $1`, [id])) > 0;
}

/**
 * Every ban, live ones first.
 *
 * Expired rows are listed rather than hidden: "this key was banned until
 * Tuesday and is not any more" is something an operator looking at a repeat
 * offender needs to see, and a list that silently drops them makes a second
 * offence look like a first one.
 */
export async function listBans(): Promise<Array<Ban & { live: boolean }>> {
  const rows = await query<BanRow & { live: boolean }>(
    `SELECT id, key_type, key, reason, actor, created_at, expires_at,
            (expires_at IS NULL OR expires_at > now()) AS live
       FROM bans
      ORDER BY (expires_at IS NULL OR expires_at > now()) DESC, created_at DESC
      LIMIT 200`,
  );
  return rows.map((row) => ({ ...toBan(row), live: row.live }));
}

export type PixelEvent = {
  seq: number;
  colourSlot: number;
  warTokenId: string | null;
  ticker: string | null;
  paintedAt: Date;
};

export type PixelInspection = {
  x: number;
  y: number;
  idx: number;
  /** Null when nothing has ever been painted here, or it was reverted. */
  current: {
    warTokenId: string;
    ticker: string | null;
    colourSlot: number;
    paintedAt: Date;
    /** The keys a ban can name. Hashed already — see `client-ip.ts`. */
    painterKey: string | null;
    ipHash: string | null;
  } | null;
  /** Oldest first. */
  timeline: PixelEvent[];
  /**
   * True when this pixel has been painted more than once.
   *
   * The honest caveat, surfaced rather than buried: `pixel_events` has never
   * carried `painter_key` or `ip_hash` — only `pixels` does, and only for the
   * painter who holds the cell right now. So for an overpainted pixel the
   * timeline is real but only the CURRENT owner is bannable from here. The
   * screen says so; see `docs/operations.md` on why the alternative was
   * refused.
   */
  earlierPaintersUnavailable: boolean;
};

/**
 * Everything recorded about one cell.
 *
 * Two queries rather than a join, because they answer different questions and
 * one of them can legitimately return nothing: a cell nobody has painted has
 * no `pixels` row and no events, and a cell that was reverted has events but
 * no row.
 */
export async function inspectPixel(
  warId: string,
  x: number,
  y: number,
  width: number,
): Promise<PixelInspection> {
  const idx = y * width + x;

  const current = await queryOne<{
    war_token_id: string;
    ticker: string | null;
    colour_slot: number;
    painted_at: Date;
    painter_key: string | null;
    ip_hash: string | null;
  }>(
    `SELECT p.war_token_id, t.ticker, p.colour_slot, p.painted_at, p.painter_key, p.ip_hash
       FROM pixels p
       LEFT JOIN war_tokens t ON t.id = p.war_token_id
      WHERE p.war_id = $1 AND p.idx = $2`,
    [warId, idx],
  );

  const events = await query<{
    seq: string;
    colour_slot: number;
    war_token_id: string | null;
    ticker: string | null;
    painted_at: Date;
  }>(
    `SELECT e.seq, e.colour_slot, e.war_token_id, t.ticker, e.painted_at
       FROM pixel_events e
       LEFT JOIN war_tokens t ON t.id = e.war_token_id
      WHERE e.war_id = $1 AND e.idx = $2
      ORDER BY e.seq ASC
      LIMIT 100`,
    [warId, idx],
  );

  const timeline = events.map((row) => ({
    seq: Number(row.seq),
    colourSlot: row.colour_slot,
    warTokenId: row.war_token_id,
    ticker: row.ticker,
    paintedAt: row.painted_at,
  }));

  return {
    x,
    y,
    idx,
    current: current
      ? {
          warTokenId: current.war_token_id,
          ticker: current.ticker,
          colourSlot: current.colour_slot,
          paintedAt: current.painted_at,
          painterKey: current.painter_key,
          ipHash: current.ip_hash,
        }
      : null,
    timeline,
    earlierPaintersUnavailable: timeline.length > 1,
  };
}

/**
 * The most cells one revert may clear.
 *
 * A bound on the transaction, not on the feature: a revert wider than this is
 * two reverts. Chosen above any plausible hand-drawn offence and well under
 * the whole board, so the operator is never fighting the tool while the site
 * is the thing on fire.
 */
export const MAX_REVERT_CELLS = 10_000;

export type RevertResult =
  | { ok: true; cleared: number; seq: number }
  | { ok: false; reason: "too_large" | "out_of_bounds"; message: string };

/**
 * Clears every painted cell in a rectangle, inclusive of both corners.
 *
 * CLEARS RATHER THAN RESTORES, and this is a limitation of the data rather
 * than a preference. Nothing stores who owned a cell before its current
 * owner: `pixels` keeps only the latest painter and `pixel_events` never
 * carried one. There is no previous state to restore to. Clearing is also
 * what moderation actually wants — the job is removing the drawing, not
 * rewinding it.
 *
 * SEQUENCES ARE ALLOCATED IN ONE BUMP, and that is what makes this safe to
 * stream. `wars.last_seq` is documented as monotonic and gapless because
 * clients hold a sequence and ask for everything after it; taking N in one
 * UPDATE and handing them out in order preserves both properties, where a
 * loop of single increments would interleave with live paints and a reset
 * would strand every open tab above the new head forever.
 *
 * The events carry `colour_slot = 0`, which every client already renders as
 * unpainted, and a NULL `war_token_id`, which the territory diff already
 * treats as a reason to resync rather than as an owner. Neither needed a new
 * case; both were built for exactly this shape of change.
 */
export async function revertRegion(input: {
  warId: string;
  width: number;
  height: number;
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}): Promise<RevertResult> {
  const { warId, width, height } = input;
  const minX = Math.min(input.x0, input.x1);
  const maxX = Math.max(input.x0, input.x1);
  const minY = Math.min(input.y0, input.y1);
  const maxY = Math.max(input.y0, input.y1);

  if (
    ![minX, maxX, minY, maxY].every(Number.isInteger) ||
    minX < 0 ||
    minY < 0 ||
    maxX >= width ||
    maxY >= height
  ) {
    return {
      ok: false,
      reason: "out_of_bounds",
      message: "That region is not on the board.",
    };
  }

  const cells = (maxX - minX + 1) * (maxY - minY + 1);
  if (cells > MAX_REVERT_CELLS) {
    return {
      ok: false,
      reason: "too_large",
      message: `A single revert covers at most ${MAX_REVERT_CELLS} cells; that region is ${cells}.`,
    };
  }

  return transaction(async (client) => {
    // Every painted cell inside the rectangle. `idx % width` is the column,
    // and Postgres can evaluate it directly — the alternative, generating the
    // index list in JS and passing 10,000 parameters, is the same query with
    // a worse plan and a parameter limit.
    const painted = await client.query<{ idx: number; war_token_id: string }>(
      `SELECT idx, war_token_id FROM pixels
        WHERE war_id = $1
          AND idx BETWEEN $2 AND $3
          AND (idx % $4) BETWEEN $5 AND $6
        FOR UPDATE`,
      [warId, minY * width + minX, maxY * width + maxX, width, minX, maxX],
    );

    if (painted.rowCount === 0) {
      const head = await client.query<{ last_seq: string }>(
        `SELECT last_seq FROM wars WHERE id = $1`,
        [warId],
      );
      return { ok: true as const, cleared: 0, seq: Number(head.rows[0]?.last_seq ?? 0) };
    }

    const rows = painted.rows;
    const indices = rows.map((row) => row.idx);

    const bumped = await client.query<{ last_seq: string }>(
      `UPDATE wars SET last_seq = last_seq + $2 WHERE id = $1 RETURNING last_seq`,
      [warId, rows.length],
    );
    const head = Number(bumped.rows[0].last_seq);
    const firstSeq = head - rows.length + 1;

    await client.query(`DELETE FROM pixels WHERE war_id = $1 AND idx = ANY($2::int[])`, [
      warId,
      indices,
    ]);

    // One event per cleared cell, in index order, so the sequence a client
    // receives is the sequence the head advertises.
    await client.query(
      `INSERT INTO pixel_events (war_id, seq, idx, colour_slot, war_token_id, painted_at)
       SELECT $1, $2 + ordinality - 1, idx, 0, NULL, now()
         FROM unnest($3::int[]) WITH ORDINALITY AS t(idx, ordinality)`,
      [warId, firstSeq, indices],
    );

    // `owned` follows the board and has to come down; `placed` is a lifetime
    // tally of paints made and does not, any more than it does when somebody
    // is painted over in the ordinary way.
    const perToken = new Map<string, number>();
    for (const row of rows) perToken.set(row.war_token_id, (perToken.get(row.war_token_id) ?? 0) + 1);
    for (const [tokenId, count] of perToken) {
      await client.query(
        `UPDATE token_pixel_counts SET owned = GREATEST(0, owned - $3)
          WHERE war_id = $1 AND war_token_id = $2`,
        [warId, tokenId, count],
      );
    }

    return { ok: true as const, cleared: rows.length, seq: head };
  });
}

/**
 * Ends a live war immediately.
 *
 * THE KILL SWITCH, and it is moderation rather than lifecycle. Reverting a
 * region assumes the board is worth keeping; when it is not — when what is on
 * screen is the reason the site has to come down — the operator needs one
 * action that stops every further paint at once. `paintPixel` refuses a war
 * that is not `live`, so this closes the door on the same request that flips
 * the row.
 *
 * `ends_at` moves as well as `status`, and that is not tidiness: the clock in
 * the rail counts to `ends_at`, and a war marked ended with an hour still on
 * its face is a screen arguing with itself. Moving it also means `advanceWar`
 * agrees with the row rather than fighting it.
 *
 * Returns false for a war that was not live, which is the honest answer for a
 * double-click as much as for a mistake.
 */
export async function endWarNow(warId: string): Promise<boolean> {
  const updated = await execute(
    `UPDATE wars
        SET status = 'ended', ended_at = now(), ends_at = now()
      WHERE id = $1 AND status = 'live'`,
    [warId],
  );
  return updated > 0;
}

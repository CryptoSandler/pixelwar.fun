import { execute, query, queryOne } from "../db";

/**
 * War state, and the two transitions that happen without an operator.
 *
 * Both transitions run on every read of a war as well as on the reconcile
 * cron. GitHub's scheduler is best-effort and can run late; a war that ended
 * eleven minutes ago must not still be accepting paint because nobody
 * triggered a job.
 */

export type WarStatus = "draft" | "scheduled" | "live" | "ended" | "cancelled";

export type War = {
  id: string;
  slug: string;
  title: string;
  status: WarStatus;
  width: number;
  height: number;
  maxTokens: number;
  entryPriceUsd: number;
  cooldownSeconds: number;
  startsAt: Date;
  endsAt: Date;
  lastSeq: number;
  endedAt: Date | null;
};

export type WarToken = {
  id: string;
  warId: string;
  chainId: string;
  contract: string;
  colourSlot: number;
  status: "reserved" | "active" | "removed" | "released";
  name: string;
  ticker: string;
  logoUrl: string | null;
};

type WarRow = {
  id: string;
  slug: string;
  title: string;
  status: WarStatus;
  width: number;
  height: number;
  max_tokens: number;
  entry_price_usd: number;
  cooldown_seconds: number;
  starts_at: Date;
  ends_at: Date;
  last_seq: string;
  ended_at: Date | null;
};

// pg returns BIGINT as a string, because a 64-bit integer does not fit a JS
// number safely. Sequence numbers here will not approach 2^53, so converting
// is safe — but it has to happen in exactly one place, or somewhere downstream
// compares "10" < "9" and serves a diff that silently skips pixels.
function toWar(row: WarRow): War {
  return {
    id: row.id,
    slug: row.slug,
    title: row.title,
    status: row.status,
    width: row.width,
    height: row.height,
    maxTokens: row.max_tokens,
    entryPriceUsd: row.entry_price_usd,
    cooldownSeconds: row.cooldown_seconds,
    startsAt: row.starts_at,
    endsAt: row.ends_at,
    lastSeq: Number(row.last_seq),
    endedAt: row.ended_at,
  };
}

const WAR_COLUMNS = `id, slug, title, status, width, height, max_tokens,
  entry_price_usd, cooldown_seconds, starts_at, ends_at, last_seq, ended_at`;

export async function warBySlug(slug: string): Promise<War | null> {
  const row = await queryOne<WarRow>(
    `SELECT ${WAR_COLUMNS} FROM wars WHERE slug = $1`,
    [slug],
  );
  return row ? toWar(row) : null;
}

export async function warById(id: string): Promise<War | null> {
  const row = await queryOne<WarRow>(`SELECT ${WAR_COLUMNS} FROM wars WHERE id = $1`, [id]);
  return row ? toWar(row) : null;
}

/**
 * Moves a war to the state its own clock says it should be in.
 *
 * Both updates are guarded on the status they expect, so two callers racing
 * produce one winner and one no-op rather than two half-closes. The loser
 * re-reads and sees the same answer.
 */
export async function advanceWar(war: War): Promise<War> {
  const now = Date.now();

  if (war.status === "scheduled" && war.startsAt.getTime() <= now) {
    await execute(`UPDATE wars SET status = 'live' WHERE id = $1 AND status = 'scheduled'`, [
      war.id,
    ]);
    return (await warById(war.id))!;
  }

  if (war.status === "live" && war.endsAt.getTime() <= now) {
    await execute(
      `UPDATE wars SET status = 'ended', ended_at = now() WHERE id = $1 AND status = 'live'`,
      [war.id],
    );
    return (await warById(war.id))!;
  }

  return war;
}

export type ReviveResult =
  | { ok: true; war: War }
  | { ok: false; reason: "not_ended" | "ends_in_the_past" };

/**
 * Brings an ended war back, with a new deadline. The third transition.
 *
 * WHY IT LIVES HERE. `advanceWar` covers `scheduled -> live` and
 * `live -> ended` and there is no path back — so extending a war that has
 * already run out has, until now, been impossible without an UPDATE typed
 * somewhere that is not a state machine. Migration 004's own comment has
 * assumed this exists since it was written ("an operator can extend a war
 * after the fact"); it simply never did. It is written next to the other two
 * so the three transitions can be read together, and so nothing is tempted
 * to reach for a bare UPDATE in a route again.
 *
 * A NEW DEADLINE IN THE PAST IS REFUSED, and the reason is not tidiness:
 *
 * - It is not an extension, it is a typo or a timezone.
 * - Allowing it produces a war that flips straight back to `ended` on the
 *   next request, which looks like a bug to everybody watching and rewrites
 *   `ended_at` for nothing.
 * - **No capability is lost.** Setting a live war's deadline to the past IS
 *   "end it now", and that already exists with its own name and a typed
 *   confirmation — `endWarNow`, the kill switch. Two routes to one action,
 *   one deliberate and one accidental, is how a war gets switched off by
 *   mistake.
 *
 * `ended_at` is cleared, because it means "when this war finished" and this
 * war has not.
 */
export async function reviveWar(warId: string, endsAt: Date): Promise<ReviveResult> {
  const war = await warById(warId);
  if (!war) return { ok: false, reason: "not_ended" };
  if (war.status !== "ended") return { ok: false, reason: "not_ended" };
  if (endsAt.getTime() <= Date.now()) return { ok: false, reason: "ends_in_the_past" };

  // Guarded on the status it expects, like the other two: two operators
  // reviving at once produce one winner and one no-op.
  const revived = await execute(
    `UPDATE wars SET status = 'live', ends_at = $2, ended_at = NULL
      WHERE id = $1 AND status = 'ended'`,
    [warId, endsAt],
  );
  if (revived === 0) return { ok: false, reason: "not_ended" };

  return { ok: true, war: (await warById(warId))! };
}

/**
 * The war the home page shows: the one that is running, or the one about to.
 *
 * Advancing happens here rather than in the caller so that no route can forget
 * to do it.
 */
export async function currentWar(): Promise<War | null> {
  // Every candidate, oldest first — not just the oldest one.
  //
  // Taking a single row and giving up when it turns out to have ended hides
  // the war queued behind it. Wars are meant to run back to back, so the
  // moment one clock runs out is exactly when the next one matters, and that
  // is also when the most people are looking. Advancing in order and
  // returning the first war still standing costs one extra query in the
  // common case and answers correctly in the case that actually hurts.
  //
  // The limit is a guard against a pathological backlog, not a real bound:
  // v1 runs one war at a time with at most one scheduled behind it.
  const rows = await query<WarRow>(
    `SELECT ${WAR_COLUMNS} FROM wars
      WHERE status IN ('live', 'scheduled')
      ORDER BY starts_at ASC
      LIMIT 10`,
  );

  for (const row of rows) {
    const advanced = await advanceWar(toWar(row));
    if (advanced.status !== "ended") return advanced;
  }

  return null;
}

export async function activeTokens(warId: string): Promise<WarToken[]> {
  const rows = await query<{
    id: string;
    war_id: string;
    chain_id: string;
    contract: string;
    colour_slot: number;
    status: WarToken["status"];
    name: string;
    ticker: string;
    logo_url: string | null;
  }>(
    `SELECT id, war_id, chain_id, contract, colour_slot, status, name, ticker, logo_url
       FROM war_tokens
      WHERE war_id = $1 AND status = 'active'
      ORDER BY colour_slot ASC`,
    [warId],
  );

  return rows.map((row) => ({
    id: row.id,
    warId: row.war_id,
    chainId: row.chain_id,
    contract: row.contract,
    colourSlot: row.colour_slot,
    status: row.status,
    name: row.name,
    ticker: row.ticker,
    logoUrl: row.logo_url,
  }));
}

import { execute, queryOne } from "../db";
import { MAX_TOKEN_SLOT } from "./palette";
import { advanceWar, REVIVE_HORIZON_DAYS, reviveWar, warById, type War } from "./lifecycle";

/**
 * The operator's clocks.
 *
 * THE ADMIN MOVES CLOCKS; IT DOES NOT INVENT STATES. `advanceWar` already
 * turns a scheduled war live at `starts_at` and a live war ended at
 * `ends_at`, on its own, without anybody pressing anything. So "start now" is
 * not a status change — it is `starts_at = now()` followed by letting the
 * state machine notice. The one exception is revival, which is a transition
 * the machine genuinely did not have, and it lives in `lifecycle.ts` beside
 * the other two rather than as an UPDATE in a route.
 *
 * WHY THIS EXISTS AT ALL. Until now the only way a war came into being was
 * `scripts/seed-war.mts`, which means running an event required a developer
 * at a terminal. That is the difference between a product and a demo.
 */

/**
 * How big a board may be, a side.
 *
 * MIRRORED BY A CHECK IN MIGRATION 018, deliberately. The constraint is what
 * makes the bound true of every row however it was written — a seed script, a
 * psql session, a future route. These constants are what let the application
 * refuse in words before Postgres refuses in its own.
 *
 * The floor is legibility: below 100 a side there is not enough board for a
 * community to draw something it recognises. The ceiling is arithmetic about
 * bytes rather than taste — `/api/canvas` serves one byte per pixel, so a
 * 1000×1000 board is a megabyte per spectator per poll, twenty-five times what
 * 200×200 costs. See `docs/operations.md`.
 */
export const MIN_BOARD_SIDE = 100;
export const MAX_BOARD_SIDE = 1000;
export const DEFAULT_BOARD_SIDE = 200;

export type CreateWarInput = {
  slug: string;
  title: string;
  /**
   * Admission in lamports. The only price a war charges since migration 015 —
   * `entry_price_usd` is written alongside it purely because that column is
   * still NOT NULL, and nothing reads it back.
   */
  entryPriceLamports: bigint;
  cooldownSeconds: number;
  startsAt: Date;
  endsAt: Date;
  width?: number;
  height?: number;
  maxTokens?: number;
};

export type OperateFailure =
  | "bad_slug"
  | "slug_taken"
  | "bad_window"
  | "bad_numbers"
  | "no_such_war"
  | "not_scheduled"
  | "not_live"
  | "ends_in_the_past"
  | "too_old_to_revive";

export type OperateResult<T> = { ok: true; value: T } | { ok: false; reason: OperateFailure; message: string };

/** Lowercase, digits and hyphens. It is a URL segment and it is forever. */
const SLUG = /^[a-z0-9][a-z0-9-]{1,62}[a-z0-9]$/;

/**
 * Opens a war, scheduled rather than live.
 *
 * NEVER LIVE ON CREATION, even when `startsAt` is in the past: `advanceWar`
 * is what turns a war live, and creating one already live would be this
 * function doing the state machine's job with none of its guards. A war
 * created with a past start becomes live on the first request that touches
 * it, which is the same moment it would have anyway.
 */
export async function createWar(input: CreateWarInput): Promise<OperateResult<War>> {
  const slug = input.slug.trim().toLowerCase();
  if (!SLUG.test(slug)) {
    return {
      ok: false,
      reason: "bad_slug",
      message: "A slug is 3–64 characters of lowercase letters, digits and hyphens.",
    };
  }
  if (input.endsAt.getTime() <= input.startsAt.getTime()) {
    return { ok: false, reason: "bad_window", message: "A war has to end after it starts." };
  }
  const maxTokens = input.maxTokens ?? 24;
  const width = input.width ?? DEFAULT_BOARD_SIDE;
  const height = input.height ?? DEFAULT_BOARD_SIDE;
  const sideOk = (n: number) =>
    Number.isInteger(n) && n >= MIN_BOARD_SIDE && n <= MAX_BOARD_SIDE;
  if (
    input.entryPriceLamports <= 0n ||
    !Number.isInteger(input.cooldownSeconds) || input.cooldownSeconds < 1 || input.cooldownSeconds > 3600 ||
    !Number.isInteger(maxTokens) || maxTokens < 1 || maxTokens > MAX_TOKEN_SLOT ||
    // Checked HERE as well as by the CHECK migration 018 adds, and neither is
    // redundant: the constraint is what makes the bound true of every row
    // whatever writes it, and this is what turns a violation into a named
    // refusal an operator can read instead of a 500 carrying Postgres's own
    // sentence about a constraint they have never heard of.
    !sideOk(width) || !sideOk(height)
  ) {
    return {
      ok: false,
      reason: "bad_numbers",
      message:
        `Entry price above zero, cooldown 1–3600 seconds, cap 1–${MAX_TOKEN_SLOT}, ` +
        `board ${MIN_BOARD_SIDE}–${MAX_BOARD_SIDE} a side.`,
    };
  }

  const clash = await queryOne<{ id: string }>(`SELECT id FROM wars WHERE slug = $1`, [slug]);
  if (clash) {
    return { ok: false, reason: "slug_taken", message: "A war already uses that slug." };
  }

  const id = crypto.randomUUID();
  await execute(
    `INSERT INTO wars (id, slug, title, status, width, height, max_tokens,
                       entry_price_usd, entry_price_sol, cooldown_seconds, starts_at, ends_at)
     VALUES ($1, $2, $3, 'scheduled', $4, $5, $6, $7, $8, $9, $10, $11)`,
    [
      id, slug, input.title.trim() || slug,
      width, height, maxTokens,
      // A placeholder for a column that is still NOT NULL and still refuses
      // zero. Nothing prices anything off it; see migration 015.
      1,
      input.entryPriceLamports.toString(),
      input.cooldownSeconds, input.startsAt, input.endsAt,
    ],
  );

  return { ok: true, value: (await warById(id))! };
}

/**
 * Moves a scheduled war's opening.
 *
 * Setting it to now (or the past) is how "start now" is expressed — the
 * status is then the state machine's business, and `advanceWar` is called
 * here only so the caller sees the answer immediately instead of on whoever's
 * next page load.
 */
export async function moveStart(warId: string, startsAt: Date): Promise<OperateResult<War>> {
  const war = await warById(warId);
  if (!war) return { ok: false, reason: "no_such_war", message: "No such war." };
  if (war.status !== "scheduled") {
    return {
      ok: false,
      reason: "not_scheduled",
      message: `That war is ${war.status}. Only a scheduled war's opening can move.`,
    };
  }
  if (war.endsAt.getTime() <= startsAt.getTime()) {
    return { ok: false, reason: "bad_window", message: "A war has to end after it starts." };
  }

  await execute(`UPDATE wars SET starts_at = $2 WHERE id = $1 AND status = 'scheduled'`, [
    warId,
    startsAt,
  ]);
  return { ok: true, value: await advanceWar((await warById(warId))!) };
}

/**
 * Pushes a war's deadline out.
 *
 * Handles both shapes with one call, because from the operator's side they
 * are one action — "give this war more time" — and which one applies depends
 * on a clock they are not watching. A LIVE war just moves its `ends_at`; an
 * ENDED one goes through `reviveWar`, which is the transition with the
 * guards on it.
 *
 * A deadline already in the past is refused for both, and for the reason
 * `reviveWar` documents: it is not an extension, and ending a war now already
 * has its own name and its own confirmation.
 */
export async function extendWar(warId: string, endsAt: Date): Promise<OperateResult<War>> {
  const war = await warById(warId);
  if (!war) return { ok: false, reason: "no_such_war", message: "No such war." };
  if (endsAt.getTime() <= Date.now()) {
    return {
      ok: false,
      reason: "ends_in_the_past",
      message: "That deadline has already passed. To stop a war now, end it.",
    };
  }

  if (war.status === "ended") {
    const revived = await reviveWar(warId, endsAt);
    if (!revived.ok) {
      // Each refusal keeps its own name and its own sentence. The old code
      // collapsed everything that was not `ends_in_the_past` into
      // `no_such_war` with "That war could not be revived." — which, once the
      // horizon existed, would have told an operator that a war they are
      // looking at does not exist. A reason the screen cannot distinguish is
      // a reason nobody can act on.
      if (revived.reason === "too_old_to_revive") {
        return {
          ok: false,
          reason: "too_old_to_revive",
          message:
            `This war ended more than ${REVIVE_HORIZON_DAYS} days ago and can no longer be revived. ` +
            `Its board and its result are kept; the pixel history has been cleared.`,
        };
      }
      return {
        ok: false,
        reason: revived.reason === "ends_in_the_past" ? "ends_in_the_past" : "no_such_war",
        message: "That war could not be revived.",
      };
    }
    return { ok: true, value: revived.war };
  }

  if (war.status !== "live" && war.status !== "scheduled") {
    return {
      ok: false,
      reason: "not_live",
      message: `A ${war.status} war has no deadline to extend.`,
    };
  }
  if (endsAt.getTime() <= war.startsAt.getTime()) {
    return { ok: false, reason: "bad_window", message: "A war has to end after it starts." };
  }

  await execute(`UPDATE wars SET ends_at = $2 WHERE id = $1`, [warId, endsAt]);
  return { ok: true, value: (await warById(warId))! };
}

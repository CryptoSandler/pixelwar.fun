import { execute, queryOne } from "../db";
import { MAX_TOKEN_SLOT } from "./palette";
import { advanceWar, reviveWar, warById, type War } from "./lifecycle";

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

export type CreateWarInput = {
  slug: string;
  title: string;
  entryPriceUsd: number;
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
  | "ends_in_the_past";

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
  if (
    !Number.isInteger(input.entryPriceUsd) || input.entryPriceUsd <= 0 ||
    !Number.isInteger(input.cooldownSeconds) || input.cooldownSeconds < 1 || input.cooldownSeconds > 3600 ||
    !Number.isInteger(maxTokens) || maxTokens < 1 || maxTokens > MAX_TOKEN_SLOT
  ) {
    return {
      ok: false,
      reason: "bad_numbers",
      message: `Entry price above zero, cooldown 1–3600 seconds, cap 1–${MAX_TOKEN_SLOT}.`,
    };
  }

  const clash = await queryOne<{ id: string }>(`SELECT id FROM wars WHERE slug = $1`, [slug]);
  if (clash) {
    return { ok: false, reason: "slug_taken", message: "A war already uses that slug." };
  }

  const id = crypto.randomUUID();
  await execute(
    `INSERT INTO wars (id, slug, title, status, width, height, max_tokens,
                       entry_price_usd, cooldown_seconds, starts_at, ends_at)
     VALUES ($1, $2, $3, 'scheduled', $4, $5, $6, $7, $8, $9, $10)`,
    [
      id, slug, input.title.trim() || slug,
      input.width ?? 200, input.height ?? 200, maxTokens,
      input.entryPriceUsd, input.cooldownSeconds, input.startsAt, input.endsAt,
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

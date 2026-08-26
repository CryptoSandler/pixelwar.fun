import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { cookies } from "next/headers";
import { execute, query, queryOne } from "./db";
import { clientIp, hashIp } from "./paint/client-ip";

/**
 * Admin access.
 *
 * Adapted from outbid-tokens' `src/lib/admin.ts`, which was shaped by three
 * findings and keeps their answers here:
 *
 *  1. The cookie carries a SESSION ID, never the master secret. The secret is
 *     never handled again after sign-in, and never leaves the environment.
 *
 *     **What that does NOT currently buy, stated because the doc used to
 *     claim it did:** there is no way to revoke somebody else's session.
 *     `revokeAdminSession` has exactly one caller, `DELETE
 *     /api/admin/session`, and it revokes the id in the calling browser's own
 *     cookie — revocation is self-service only. Rotating `ADMIN_TOKEN` to a
 *     NEW value does not kill live sessions either, because a session row
 *     stores a label and never the secret, so nothing about it changes when
 *     the secret does. An operator whose cookie leaked has two real options:
 *     CLEAR `ADMIN_TOKEN`, which does kill every live session
 *     (`resolveAdminSession` gates on `adminConfigured`) at the cost of taking
 *     the whole surface down, or psql. A revoke-any-session surface is the
 *     missing piece; it is named here rather than implied, per CLAUDE.md's
 *     rule that a capability nobody built is a capability nobody has.
 *  2. FAILED LOGINS ARE COUNTED AND LOCKED OUT. An endpoint that answers "is
 *     this the token?" without limit is a brute-force oracle, and a short
 *     hand-typed secret does not survive one.
 *  3. THE TOKEN COMPARISON IS OVER FIXED-LENGTH SHA-256 DIGESTS, so it cannot
 *     leak the secret's length through an early return, and every configured
 *     token is checked even after a match, so the time taken does not reveal
 *     which one matched.
 *
 * And it FAILS CLOSED. With `ADMIN_TOKEN` unset there is no admin surface at
 * all: not an open one, not a partly open one, and not one a live session
 * cookie minted while the token was set can still get into. Every path that
 * turns a cookie or a header into an identity checks `adminConfigured()`
 * first — see `resolveAdminSession`.
 *
 * WHO CALLS THIS: `POST /api/admin/session` signs in and `DELETE` on the same
 * route signs out (`src/app/api/admin/session/route.ts`). `authenticateAdmin`
 * and `adminSessionLabel` are for the `/admin/orphans` surface over
 * `unmatched_payments`, which is Task 2 of this batch and does not exist yet.
 * Stated out loud because this repo has shipped finished, tested modules that
 * nothing ever called (see AGENTS.md).
 */

export const ADMIN_COOKIE = "pixelwar_admin";

/** How long a signed-in session lasts before it has to be established again. */
export const ADMIN_SESSION_HOURS = 12;

/**
 * The lockout. Five wrong guesses buys a fifteen-minute wait, which is what
 * turns an unlimited oracle into roughly twenty guesses an hour.
 */
export const ADMIN_LOGIN_LIMITS = {
  maxFailures: 5,
  /** How far back failures are counted from. */
  windowMinutes: 15,
  /** How long the lockout lasts, measured from the most recent failure. */
  lockoutMinutes: 15,
} as const;

/**
 * The configured token, with a label so a session row can say which operator
 * it belongs to.
 *
 * A list of one, deliberately: `ADMIN_TOKEN` is the single-operator form and
 * is the only form this project reads. The source project also parsed an
 * `ADMIN_TOKENS` list of "label:secret" pairs; that is dropped here rather
 * than carried, because it is a second environment variable to document and a
 * parser to maintain for a second operator this project does not have. The
 * shape below — a list, and a label on each entry — is what makes bringing it
 * back a change to this one function and not to the schema.
 */
export function adminTokens(): { label: string; secret: string }[] {
  const single = process.env.ADMIN_TOKEN?.trim();
  return single ? [{ label: "admin", secret: single }] : [];
}

/** False means the admin surface refuses everything. It never means "open". */
export function adminConfigured(): boolean {
  return adminTokens().length > 0;
}

function digest(value: string): Buffer {
  return createHash("sha256").update(value, "utf8").digest();
}

/**
 * The label of the matching token, or null.
 *
 * Compares SHA-256 digests so both sides are always 32 bytes. A raw
 * comparison would need a length check first — `timingSafeEqual` throws
 * outright on buffers of different lengths — and that check is itself an
 * oracle, answering "how long is the secret" one guess at a time. Over
 * digests, a wrong-length guess costs exactly what a wrong-content one does.
 *
 * The loop does not break on a match. Every configured token is compared
 * whatever happens, so the time taken cannot say which one it was. With one
 * token configured that property is trivially true; the shape is kept so it
 * stays true if a second is ever added.
 */
export function identifyToken(candidate: string): string | null {
  const tokens = adminTokens();
  if (tokens.length === 0) return null;

  const offered = digest(candidate);
  let matched: string | null = null;

  for (const token of tokens) {
    if (timingSafeEqual(offered, digest(token.secret))) matched ??= token.label;
  }

  return matched;
}

// --- Who is calling ----------------------------------------------------------

export type AdminCaller = { ok: true; ipHash: string } | { ok: false; reason: string };

/**
 * The caller's hashed address, or a refusal.
 *
 * Fails closed, and this is the one real departure from the source module,
 * which bucketed an untrustworthy caller under a literal "unknown". That
 * bucket is shared by everyone it cannot identify, so the first anonymous
 * caller to burn five guesses locks the operator out of their own admin
 * surface — a lockout on a shared key is a denial of service against the
 * person it was built to protect. This project already refuses rather than
 * shares (see `clientIp` in `paint/client-ip.ts`, and `identify` in
 * `http.ts`), and the reason it gives names the environment variable that
 * switches address trust off, so it goes to the server log and never to the
 * caller.
 *
 * The exception, named here because the paragraph above otherwise reads as a
 * guarantee it is not: with `ALLOW_UNTRUSTED_CLIENT_IP=true`, `clientIp` does
 * not refuse — it returns the literal `untrusted-local` for every caller
 * (`paint/client-ip.ts`), so this function succeeds and hands back the one
 * hash they all share. That is exactly the shared bucket described above,
 * reinstated: under that flag anybody can spend the operator's five guesses,
 * and the lockout becomes a denial of service rather than a defence against
 * one. The flag is development-only and `.env.example` says it must stay
 * unset in production; this note is here so nobody reads "fails closed" as
 * "cannot share a bucket".
 */
export function adminCaller(request: Request): AdminCaller {
  const identity = clientIp(request);
  if (!identity.ok) return { ok: false, reason: identity.reason };
  return { ok: true, ipHash: hashIp(identity.ip) };
}

// --- Sessions ----------------------------------------------------------------

export async function createAdminSession(
  label: string,
  ipHash: string | null,
): Promise<{ id: string; expiresAt: Date }> {
  const id = randomBytes(32).toString("hex");
  const now = new Date();
  const expiresAt = new Date(now.getTime() + ADMIN_SESSION_HOURS * 3_600_000);

  await execute(
    `INSERT INTO admin_sessions (id, token_label, ip_hash, created_at, expires_at)
     VALUES ($1,$2,$3,$4,$5)`,
    [id, label, ipHash, now, expiresAt],
  );

  return { id, expiresAt };
}

/**
 * The operator a session id belongs to, or null.
 *
 * The `adminConfigured` gate is here rather than only at the callers because
 * this is the single choke point where a cookie becomes an identity. Clearing
 * `ADMIN_TOKEN` is how an operator turns the admin surface off in a hurry,
 * and it has to take the sessions already signed in with it — otherwise
 * "unset" means "closed to new logins, open to whoever is already holding a
 * cookie", which is not closed.
 */
export async function resolveAdminSession(id: string): Promise<{ label: string } | null> {
  if (!adminConfigured()) return null;

  const row = await queryOne<{ token_label: string }>(
    `SELECT token_label FROM admin_sessions
      WHERE id = $1 AND revoked_at IS NULL AND expires_at > now()`,
    [id],
  );
  return row ? { label: row.token_label } : null;
}

export async function revokeAdminSession(id: string): Promise<void> {
  await execute(`UPDATE admin_sessions SET revoked_at = now() WHERE id = $1`, [id]);
}

// --- Login throttling --------------------------------------------------------

export type LoginGate = { ok: true } | { ok: false; message: string; retryAfterSeconds: number };

export async function recordLoginAttempt(
  ipHash: string,
  label: string | null,
  succeeded: boolean,
): Promise<void> {
  await execute(
    `INSERT INTO admin_login_attempts (id, ip_hash, token_label, succeeded, attempted_at)
     VALUES ($1,$2,$3,$4,$5)`,
    [randomUUID(), ipHash, label, succeeded, new Date()],
  );
  await pruneAdminRecords();
}

/**
 * How long a dead session row or a login attempt is kept.
 *
 * Far wider than anything that reads either table needs — the lockout counts
 * back `ADMIN_LOGIN_LIMITS.windowMinutes` (15) and a session lives
 * `ADMIN_SESSION_HOURS` (12) — because the retention is not for the code, it
 * is for the operator. "When did this token last work", "was anybody trying
 * this while I was away": both are asked after the fact, and a sweep tight
 * enough to serve only the queries above would answer neither. A month of
 * history on two tables that take a row per sign-in attempt is nothing to
 * store, and it is bounded, which is the whole point.
 */
const ADMIN_SWEEP_DAYS = 30;

/**
 * Sweeps both admin tables, the way `pruneVerificationAttempts` sweeps
 * `verification_attempts` (`settle.ts`): from the write path that produces the
 * rows, not from a job of its own. Neither table has any sweep today, so both
 * grow forever — slowly, which is exactly why nothing would ever notice.
 *
 * WHO CALLS THIS: `recordLoginAttempt`, above, and that is enough to cover
 * both tables. Every `admin_sessions` row is written by `createAdminSession`,
 * which only ever runs immediately after a successful attempt has been
 * recorded (`POST /api/admin/session`), and the header path in
 * `authenticateAdmin` records an attempt too. So the sweep runs at least once
 * per row either table gains. It deliberately does NOT hang off
 * `resolveAdminSession`: that is the hot path every admin request takes, and a
 * DELETE on it would spend a write on every page load to reap a handful of
 * rows a month.
 *
 * The `admin_sessions_live (expires_at, revoked_at)` index from migration 005
 * is already declared to be "for the sweep that reaps dead rows rather than
 * for the hot path" — this is that sweep. Expiry rather than revocation is the
 * predicate: a revoked session still expires on schedule, so one bound covers
 * both, and a row cannot authenticate anything once `expires_at` has passed.
 */
async function pruneAdminRecords(): Promise<void> {
  await execute(
    `DELETE FROM admin_sessions WHERE expires_at <= now() - ($1 || ' days')::interval`,
    [String(ADMIN_SWEEP_DAYS)],
  );
  await execute(
    `DELETE FROM admin_login_attempts WHERE attempted_at <= now() - ($1 || ' days')::interval`,
    [String(ADMIN_SWEEP_DAYS)],
  );
}

/**
 * Locks a caller out after repeated failures.
 *
 * Counted from the most recent failures backwards rather than from a fixed
 * window start, so an attacker cannot wait out a boundary and resume at full
 * speed. A success ends the streak, so an operator who mistypes four times
 * and then gets in is not one typo away from locking themselves out an hour
 * later.
 */
export async function checkAdminLoginGate(ipHash: string): Promise<LoginGate> {
  const since = new Date(Date.now() - ADMIN_LOGIN_LIMITS.windowMinutes * 60_000);

  const recent = await query<{ succeeded: boolean; attempted_at: Date }>(
    `SELECT succeeded, attempted_at FROM admin_login_attempts
      WHERE ip_hash = $1 AND attempted_at > $2
      ORDER BY attempted_at DESC
      LIMIT 50`,
    [ipHash, since],
  );

  let failures = 0;
  let newestFailure: Date | null = null;
  for (const attempt of recent) {
    if (attempt.succeeded) break;
    failures++;
    newestFailure ??= attempt.attempted_at;
  }

  if (failures < ADMIN_LOGIN_LIMITS.maxFailures) return { ok: true };

  const unlocksAt = new Date(
    (newestFailure?.getTime() ?? Date.now()) + ADMIN_LOGIN_LIMITS.lockoutMinutes * 60_000,
  );
  const seconds = Math.ceil((unlocksAt.getTime() - Date.now()) / 1000);
  if (seconds <= 0) return { ok: true };

  return {
    ok: false,
    retryAfterSeconds: seconds,
    message: `Too many failed attempts. Locked for ${Math.ceil(seconds / 60)} more minute(s).`,
  };
}

// --- Request authentication --------------------------------------------------

export type AdminIdentity = { ok: true; label: string } | { ok: false };

/** The admin cookie on this request, still URL-encoded, or null. */
function cookieFrom(request: Request): string | null {
  return (
    request.headers
      .get("cookie")
      ?.split(";")
      .map((part) => part.trim())
      .find((part) => part.startsWith(`${ADMIN_COOKIE}=`))
      ?.slice(ADMIN_COOKIE.length + 1) ?? null
  );
}

/**
 * For route handlers.
 *
 * A session cookie identifies a signed-in operator. A raw token header is
 * accepted too, so one secret can drive a caller that has no browser, and
 * that path is labelled distinctly so a session row and a header call are
 * never confused for each other. The header path is a login like any other:
 * it is gated and it is recorded, because unlimited guesses there would make
 * the lockout on the form decorative.
 */
export async function authenticateAdmin(request: Request): Promise<AdminIdentity> {
  if (!adminConfigured()) return { ok: false };

  const cookie = cookieFrom(request);
  if (cookie) {
    let decoded: string;
    try {
      decoded = decodeURIComponent(cookie);
    } catch {
      // decodeURIComponent throws on a malformed escape — a cookie of "%" is
      // enough. A junk cookie is a failed authentication, not a 500.
      decoded = cookie;
    }
    const session = await resolveAdminSession(decoded);
    if (session) return { ok: true, label: session.label };
  }

  const header =
    request.headers.get("x-admin-token") ??
    request.headers.get("authorization")?.replace(/^Bearer\s+/i, "") ??
    null;

  if (header) {
    const caller = adminCaller(request);
    if (!caller.ok) {
      // No trustworthy address means no bucket to count this guess against,
      // and an uncounted guess is the oracle the lockout exists to close.
      console.error(`admin: refusing a token header with no trusted address. ${caller.reason}`);
      return { ok: false };
    }

    const gate = await checkAdminLoginGate(caller.ipHash);
    if (!gate.ok) return { ok: false };

    const label = identifyToken(header);
    await recordLoginAttempt(caller.ipHash, label, label !== null);
    if (label) return { ok: true, label: `${label} (token)` };
  }

  return { ok: false };
}

/**
 * For server components — the `/admin` pages Task 2 adds. Reads the cookie
 * through `next/headers` rather than a Request, which a page does not have.
 */
export async function adminSessionLabel(): Promise<string | null> {
  if (!adminConfigured()) return null;
  const store = await cookies();
  const value = store.get(ADMIN_COOKIE)?.value;
  if (!value) return null;
  const session = await resolveAdminSession(value);
  return session?.label ?? null;
}

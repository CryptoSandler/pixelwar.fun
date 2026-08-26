import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  ADMIN_COOKIE,
  ADMIN_LOGIN_LIMITS,
  adminCaller,
  adminConfigured,
  authenticateAdmin,
  checkAdminLoginGate,
  createAdminSession,
  identifyToken,
  recordLoginAttempt,
  resolveAdminSession,
  revokeAdminSession,
} from "../admin";
import { query } from "../db";
import { hashIp } from "../paint/client-ip";

/**
 * Admin access, adapted from outbid-tokens. Three properties are what this
 * file is here to hold down — the cookie carries a revocable session id and
 * not the secret, failed logins are counted and locked out, and the token
 * comparison leaks neither the secret's length nor which token matched — plus
 * the one this project adds: unset means REFUSE, never open.
 *
 * Every test here talks to Postgres, so every one carries its own
 * `{ timeout: 20_000 }`. The suite truncates between tests (vitest.setup.ts).
 */

const TOKEN = "an-admin-secret-for-tests-4a91c7";
const IP = hashIp("203.0.113.7");
const OTHER_IP = hashIp("198.51.100.9");

/** A request the trusted-proxy rules will accept: one hop, one entry. */
function request(headers: Record<string, string> = {}): Request {
  return new Request("https://pixelwar.fun/api/admin/orphans", {
    headers: { "x-forwarded-for": "203.0.113.7", ...headers },
  });
}

beforeEach(() => {
  vi.unstubAllEnvs();
  vi.stubEnv("ADMIN_TOKEN", TOKEN);
});

describe("token identification", () => {
  it("recognises the configured token and nothing else", { timeout: 20_000 }, () => {
    expect(adminConfigured()).toBe(true);
    expect(identifyToken(TOKEN)).toBe("admin");
    expect(identifyToken("wrong")).toBeNull();
    expect(identifyToken("")).toBeNull();
  });

  it("does not leak the secret's length through an early return", { timeout: 20_000 }, () => {
    // The comparison is over SHA-256 digests, so both sides are always 32
    // bytes and a wrong-length guess costs the same as a wrong-content one.
    // None of these may throw: timingSafeEqual on mismatched lengths does.
    expect(identifyToken("x")).toBeNull();
    expect(identifyToken("x".repeat(4096))).toBeNull();
    expect(identifyToken(`${TOKEN}X`)).toBeNull();
    expect(identifyToken(TOKEN.slice(0, -1))).toBeNull();
  });
});

describe("fail closed when ADMIN_TOKEN is unset", () => {
  it("reports nothing configured, and matches nothing", { timeout: 20_000 }, () => {
    vi.stubEnv("ADMIN_TOKEN", "");
    expect(adminConfigured()).toBe(false);
    expect(identifyToken("anything")).toBeNull();
    expect(identifyToken("")).toBeNull();
  });

  it(
    "refuses a request carrying what would have been the right token",
    { timeout: 20_000 },
    async () => {
      // The token IS the configured one — right up until the variable is
      // cleared. Unset must mean refuse, not "open to whoever knows it".
      expect(await authenticateAdmin(request({ "x-admin-token": TOKEN }))).toEqual({ ok: true, label: "admin (token)" });

      vi.stubEnv("ADMIN_TOKEN", "");
      expect(await authenticateAdmin(request({ "x-admin-token": TOKEN }))).toEqual({ ok: false });
    },
  );

  it("takes the sessions already signed in with it", { timeout: 20_000 }, async () => {
    const session = await createAdminSession("admin", IP);
    expect(await resolveAdminSession(session.id)).toEqual({ label: "admin" });

    vi.stubEnv("ADMIN_TOKEN", "");
    expect(await resolveAdminSession(session.id)).toBeNull();
    expect(
      await authenticateAdmin(request({ cookie: `${ADMIN_COOKIE}=${session.id}` })),
    ).toEqual({ ok: false });
  });

  it("records no attempt at all, so it cannot be used as an oracle", { timeout: 20_000 }, async () => {
    vi.stubEnv("ADMIN_TOKEN", "");
    await authenticateAdmin(request({ "x-admin-token": TOKEN }));
    expect(await query(`SELECT id FROM admin_login_attempts`)).toHaveLength(0);
  });
});

describe("login lockout", () => {
  it("allows attempts up to the limit", { timeout: 20_000 }, async () => {
    for (let i = 0; i < ADMIN_LOGIN_LIMITS.maxFailures - 1; i++) {
      expect((await checkAdminLoginGate(IP)).ok).toBe(true);
      await recordLoginAttempt(IP, null, false);
    }
    expect((await checkAdminLoginGate(IP)).ok).toBe(true);
  });

  it("locks out after enough failures, and says for how long", { timeout: 20_000 }, async () => {
    for (let i = 0; i < ADMIN_LOGIN_LIMITS.maxFailures; i++) {
      await recordLoginAttempt(IP, null, false);
    }

    const gate = await checkAdminLoginGate(IP);
    expect(gate.ok).toBe(false);
    if (gate.ok) return;
    expect(gate.message).toMatch(/Too many failed attempts/i);
    expect(gate.retryAfterSeconds).toBeGreaterThan(0);
    expect(gate.retryAfterSeconds).toBeLessThanOrEqual(ADMIN_LOGIN_LIMITS.lockoutMinutes * 60);
  });

  it("does not lock out a different caller", { timeout: 20_000 }, async () => {
    for (let i = 0; i < ADMIN_LOGIN_LIMITS.maxFailures; i++) {
      await recordLoginAttempt(IP, null, false);
    }
    expect((await checkAdminLoginGate(IP)).ok).toBe(false);
    expect((await checkAdminLoginGate(OTHER_IP)).ok).toBe(true);
  });

  it("clears the streak on a success", { timeout: 20_000 }, async () => {
    for (let i = 0; i < ADMIN_LOGIN_LIMITS.maxFailures - 1; i++) {
      await recordLoginAttempt(IP, null, false);
    }
    await recordLoginAttempt(IP, "admin", true);
    for (let i = 0; i < ADMIN_LOGIN_LIMITS.maxFailures - 1; i++) {
      await recordLoginAttempt(IP, null, false);
    }
    // Without the streak reset these would add up to a lockout.
    expect((await checkAdminLoginGate(IP)).ok).toBe(true);
  });

  it("releases the lockout once the window passes", { timeout: 20_000 }, async () => {
    for (let i = 0; i < ADMIN_LOGIN_LIMITS.maxFailures; i++) {
      await recordLoginAttempt(IP, null, false);
    }
    expect((await checkAdminLoginGate(IP)).ok).toBe(false);

    await query(`UPDATE admin_login_attempts SET attempted_at = $1 WHERE ip_hash = $2`, [
      new Date(Date.now() - (ADMIN_LOGIN_LIMITS.lockoutMinutes + 1) * 60_000),
      IP,
    ]);

    expect((await checkAdminLoginGate(IP)).ok).toBe(true);
  });
});

describe("sessions", () => {
  it("resolves a session to the operator who created it", { timeout: 20_000 }, async () => {
    const session = await createAdminSession("admin", IP);
    expect(await resolveAdminSession(session.id)).toEqual({ label: "admin" });
  });

  it("carries an expiry rather than living forever", { timeout: 20_000 }, async () => {
    const session = await createAdminSession("admin", IP);
    expect(session.expiresAt.getTime()).toBeGreaterThan(Date.now());

    await query(`UPDATE admin_sessions SET expires_at = $1 WHERE id = $2`, [
      new Date(Date.now() - 1000),
      session.id,
    ]);
    expect(await resolveAdminSession(session.id)).toBeNull();
  });

  it("can be revoked server-side, so a leaked cookie is not a rotation", { timeout: 20_000 }, async () => {
    const session = await createAdminSession("admin", IP);
    await revokeAdminSession(session.id);
    expect(await resolveAdminSession(session.id)).toBeNull();
  });

  it("never stores the token, and never puts it in the cookie", { timeout: 20_000 }, async () => {
    const session = await createAdminSession("admin", IP);

    const rows = await query<{ id: string; token_label: string; ip_hash: string | null }>(
      `SELECT id, token_label, ip_hash FROM admin_sessions`,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].token_label).toBe("admin");
    // The id is what goes in the cookie. It is 32 random bytes, and it is not
    // the secret in any spelling.
    expect(rows[0].id).toMatch(/^[0-9a-f]{64}$/);
    expect(rows[0].id).not.toContain(TOKEN);
    expect(session.id).not.toContain(TOKEN);
    // The address is stored hashed, never in the clear.
    expect(rows[0].ip_hash).toBe(IP);
    expect(rows[0].ip_hash).not.toContain("203.0.113.7");
  });

  it("rejects an unknown session id", { timeout: 20_000 }, async () => {
    expect(await resolveAdminSession("nope")).toBeNull();
  });
});

describe("authenticating a request", () => {
  it("accepts a live session cookie", { timeout: 20_000 }, async () => {
    const session = await createAdminSession("admin", IP);
    expect(await authenticateAdmin(request({ cookie: `${ADMIN_COOKIE}=${session.id}` }))).toEqual({
      ok: true,
      label: "admin",
    });
  });

  it("rejects a revoked session cookie", { timeout: 20_000 }, async () => {
    const session = await createAdminSession("admin", IP);
    await revokeAdminSession(session.id);
    expect(await authenticateAdmin(request({ cookie: `${ADMIN_COOKIE}=${session.id}` }))).toEqual({
      ok: false,
    });
  });

  it("does not 500 on a malformed cookie", { timeout: 20_000 }, async () => {
    expect(await authenticateAdmin(request({ cookie: `${ADMIN_COOKIE}=%` }))).toEqual({ ok: false });
  });

  it("labels the header path distinctly from a session", { timeout: 20_000 }, async () => {
    expect(await authenticateAdmin(request({ "x-admin-token": TOKEN }))).toEqual({
      ok: true,
      label: "admin (token)",
    });
    expect(await authenticateAdmin(request({ authorization: `Bearer ${TOKEN}` }))).toEqual({
      ok: true,
      label: "admin (token)",
    });
  });

  it("counts header guesses, and locks them out too", { timeout: 20_000 }, async () => {
    for (let i = 0; i < ADMIN_LOGIN_LIMITS.maxFailures; i++) {
      expect(await authenticateAdmin(request({ "x-admin-token": "guess" }))).toEqual({ ok: false });
    }
    expect(await query(`SELECT id FROM admin_login_attempts`)).toHaveLength(
      ADMIN_LOGIN_LIMITS.maxFailures,
    );

    // The right token now, and it is still refused: the lockout is on the
    // caller, not on the guess. Without this an attacker gets the lockout's
    // worth of guesses per window forever.
    expect(await authenticateAdmin(request({ "x-admin-token": TOKEN }))).toEqual({ ok: false });
  });

  it("refuses a token header from an address it cannot trust", { timeout: 20_000 }, async () => {
    // No trustworthy address means no bucket to count the guess against, and
    // an uncounted guess is the oracle the lockout exists to close.
    vi.stubEnv("ALLOW_UNTRUSTED_CLIENT_IP", "");
    const bare = new Request("https://pixelwar.fun/api/admin/orphans", {
      headers: { "x-admin-token": TOKEN },
    });
    expect(adminCaller(bare).ok).toBe(false);
    expect(await authenticateAdmin(bare)).toEqual({ ok: false });
    expect(await query(`SELECT id FROM admin_login_attempts`)).toHaveLength(0);
  });

  it("refuses a request carrying neither cookie nor token", { timeout: 20_000 }, async () => {
    expect(await authenticateAdmin(request())).toEqual({ ok: false });
    expect(await query(`SELECT id FROM admin_login_attempts`)).toHaveLength(0);
  });
});

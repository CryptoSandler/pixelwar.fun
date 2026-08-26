import { beforeEach, describe, expect, it, vi } from "vitest";
import { ADMIN_COOKIE, ADMIN_LOGIN_LIMITS, resolveAdminSession } from "../../../lib/admin";
import { query } from "../../../lib/db";
import { DELETE as signOut, POST as signIn } from "../admin/session/route";

/**
 * The sign-in and sign-out endpoint.
 *
 * What these assert is the surface an operator actually touches: that an
 * unconfigured deployment refuses everything, that what comes back in the
 * cookie is a session id and not the secret, and that the lockout reaches the
 * form and not only the module underneath it.
 *
 * Every test here writes to Postgres, so every one carries `{ timeout: 20_000 }`.
 */

const TOKEN = "an-admin-secret-for-tests-4a91c7";

function signInRequest(token: string, headers: Record<string, string> = {}): Request {
  return new Request("https://pixelwar.fun/api/admin/session", {
    method: "POST",
    // One x-forwarded-for entry, which is what TRUSTED_PROXY_HOPS=1 expects.
    headers: { "x-forwarded-for": "203.0.113.7", ...headers },
    body: new URLSearchParams({ token }),
  });
}

/** The session id out of a Set-Cookie header, or null. */
function sessionCookie(response: Response): string | null {
  const header = response.headers.get("set-cookie");
  const value = header
    ?.split(";")[0]
    ?.trim()
    ?.slice(`${ADMIN_COOKIE}=`.length);
  return value ? decodeURIComponent(value) : null;
}

beforeEach(() => {
  vi.unstubAllEnvs();
  vi.stubEnv("ADMIN_TOKEN", TOKEN);
});

describe("POST /api/admin/session", () => {
  it("signs in, and the cookie carries a session id, not the token", { timeout: 20_000 }, async () => {
    const response = await signIn(signInRequest(TOKEN));

    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe("/admin");

    const id = sessionCookie(response);
    expect(id).toMatch(/^[0-9a-f]{64}$/);
    expect(response.headers.get("set-cookie")).not.toContain(TOKEN);
    expect(await resolveAdminSession(id!)).toEqual({ label: "admin" });

    const cookie = response.headers.get("set-cookie") ?? "";
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("SameSite=Strict");
    expect(cookie).toContain("Secure");
  });

  it("leaves Secure off only on plain-HTTP localhost", { timeout: 20_000 }, async () => {
    const local = new Request("http://localhost:3000/api/admin/session", {
      method: "POST",
      headers: { "x-forwarded-for": "203.0.113.7" },
      body: new URLSearchParams({ token: TOKEN }),
    });
    expect(await signIn(local).then((r) => r.headers.get("set-cookie"))).not.toContain("Secure");

    // A TLS-terminating proxy in front means the request URL's own scheme is
    // the plain hop behind it. The forwarded scheme is what decides.
    const proxied = new Request("http://internal:3000/api/admin/session", {
      method: "POST",
      headers: { "x-forwarded-for": "203.0.113.7", "x-forwarded-proto": "https" },
      body: new URLSearchParams({ token: TOKEN }),
    });
    expect(await signIn(proxied).then((r) => r.headers.get("set-cookie"))).toContain("Secure");
  });

  it("refuses the wrong token without setting a cookie", { timeout: 20_000 }, async () => {
    const response = await signIn(signInRequest("wrong"));

    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe("/admin?error=1");
    expect(response.headers.get("set-cookie")).toBeNull();
    expect(await query(`SELECT id FROM admin_sessions`)).toHaveLength(0);
    // Counted, or the lockout has nothing to count.
    expect(await query(`SELECT succeeded FROM admin_login_attempts`)).toEqual([
      { succeeded: false },
    ]);
  });

  it("locks the form out after enough failures", { timeout: 20_000 }, async () => {
    for (let i = 0; i < ADMIN_LOGIN_LIMITS.maxFailures; i++) {
      await signIn(signInRequest("wrong"));
    }

    const locked = await signIn(signInRequest(TOKEN));
    expect(locked.headers.get("location")).toBe("/admin?error=locked");
    expect(Number(locked.headers.get("retry-after"))).toBeGreaterThan(0);
    expect(locked.headers.get("set-cookie")).toBeNull();
    // The right token, and still no session: the lockout is on the caller.
    expect(await query(`SELECT id FROM admin_sessions`)).toHaveLength(0);
  });

  it("refuses everything when ADMIN_TOKEN is unset", { timeout: 20_000 }, async () => {
    vi.stubEnv("ADMIN_TOKEN", "");

    // The token submitted here IS the one this deployment used to accept.
    const response = await signIn(signInRequest(TOKEN));

    expect(response.status).toBe(503);
    expect(response.headers.get("set-cookie")).toBeNull();
    expect(await query(`SELECT id FROM admin_sessions`)).toHaveLength(0);
    // It does not even reach the attempt log: unset is not a login that failed,
    // it is a surface that does not exist.
    expect(await query(`SELECT id FROM admin_login_attempts`)).toHaveLength(0);
    expect(await response.json()).toEqual({
      error: "Admin access is not configured on this deployment.",
    });
  });

  it("refuses a caller whose address cannot be trusted", { timeout: 20_000 }, async () => {
    vi.stubEnv("ALLOW_UNTRUSTED_CLIENT_IP", "");
    const bare = new Request("https://pixelwar.fun/api/admin/session", {
      method: "POST",
      body: new URLSearchParams({ token: TOKEN }),
    });

    const response = await signIn(bare);
    expect(response.status).toBe(400);
    expect(response.headers.get("set-cookie")).toBeNull();
    // The message must not name the environment variable that switches
    // address trust off; that detail is for the server log.
    expect(await response.json()).toEqual({ error: "This request could not be verified." });
  });

  it("rejects a body that is not a form submission", { timeout: 20_000 }, async () => {
    const response = await signIn(
      new Request("https://pixelwar.fun/api/admin/session", {
        method: "POST",
        headers: { "x-forwarded-for": "203.0.113.7", "content-type": "application/json" },
        body: "{}",
      }),
    );
    expect(response.status).toBe(400);
    expect(await query(`SELECT id FROM admin_sessions`)).toHaveLength(0);
  });
});

describe("DELETE /api/admin/session", () => {
  it("revokes the session server-side, not just in the browser", { timeout: 20_000 }, async () => {
    const id = sessionCookie(await signIn(signInRequest(TOKEN)))!;
    expect(await resolveAdminSession(id)).not.toBeNull();

    const response = await signOut(
      new Request("https://pixelwar.fun/api/admin/session", {
        method: "DELETE",
        headers: { cookie: `${ADMIN_COOKIE}=${id}` },
      }),
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("set-cookie")).toContain("Max-Age=0");
    // The row, not just the cookie: a browser that keeps its copy gets nothing.
    expect(await resolveAdminSession(id)).toBeNull();
    expect(await query(`SELECT revoked_at FROM admin_sessions WHERE id = $1`, [id])).not.toEqual([
      { revoked_at: null },
    ]);
  });

  it("is harmless with no cookie at all", { timeout: 20_000 }, async () => {
    const response = await signOut(
      new Request("https://pixelwar.fun/api/admin/session", { method: "DELETE" }),
    );
    expect(response.status).toBe(200);
  });

  it(
    "writes nothing when ADMIN_TOKEN is unset, whatever cookie is presented",
    { timeout: 20_000 },
    async () => {
      // Sign-out grants nothing, so this is not an auth hole — but "unset
      // ADMIN_TOKEN refuses everything" has to be true of every path and not
      // only of the paths that grant, or the sentence means something narrower
      // than it says. Without the gate this endpoint was an unauthenticated,
      // unmetered UPDATE against admin_sessions on a deployment with no admin
      // surface at all.
      const id = sessionCookie(await signIn(signInRequest(TOKEN)))!;
      vi.unstubAllEnvs();

      const response = await signOut(
        new Request("https://pixelwar.fun/api/admin/session", {
          method: "DELETE",
          headers: { cookie: `${ADMIN_COOKIE}=${id}` },
        }),
      );

      expect(response.status).toBe(503);
      // The row is untouched: the refusal happened before any statement ran.
      expect(await query(`SELECT revoked_at FROM admin_sessions WHERE id = $1`, [id])).toEqual([
        { revoked_at: null },
      ]);
    },
  );
});

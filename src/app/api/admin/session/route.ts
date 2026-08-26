import {
  ADMIN_COOKIE,
  adminCaller,
  adminConfigured,
  checkAdminLoginGate,
  createAdminSession,
  identifyToken,
  recordLoginAttempt,
  resolveAdminSession,
  revokeAdminSession,
} from "../../../../lib/admin";
import { json, NO_STORE } from "../../../../lib/http";

export const dynamic = "force-dynamic";

/**
 * Signing in and out of the admin surface.
 *
 * What comes out of POST is a cookie holding a SESSION ID, never the token: a
 * leaked cookie is then a row to revoke rather than a secret to rotate across
 * every deployment. DELETE revokes that row server-side, so signing out is a
 * fact about the server and not a request the browser was asked to honour.
 *
 * WHO CALLS THIS: the sign-in form on `/admin`, which is Task 2 of this batch.
 * A plain HTML form, hence form-encoded in and a 303 back out rather than
 * JSON — a login that needs client-side JavaScript to work is a login that
 * does not work when the JavaScript fails.
 */

/** Redirect back to /admin. Relative on purpose: it needs no notion of origin. */
function backToAdmin(query: string, extra: Record<string, string> = {}): Response {
  return new Response(null, {
    status: 303,
    headers: { location: `/admin${query}`, ...NO_STORE, ...extra },
  });
}

export async function POST(request: Request): Promise<Response> {
  // Fails closed. An unset ADMIN_TOKEN means this deployment has no admin
  // surface, not that the admin surface is open to everybody — so this
  // refuses before it so much as looks at what was submitted, and a request
  // carrying what would have been the right token is refused with the rest.
  // 503 rather than 401 because the fault is this deployment's configuration,
  // not the caller's credentials.
  if (!adminConfigured()) {
    console.error("admin/session: ADMIN_TOKEN is not set; refusing every request.");
    return json(
      { error: "Admin access is not configured on this deployment." },
      { status: 503, headers: NO_STORE },
    );
  }

  const caller = adminCaller(request);
  if (!caller.ok) {
    // Without a trustworthy address there is no bucket to count this guess
    // against, and an uncounted guess is exactly the oracle the lockout
    // exists to close. The reason names ALLOW_UNTRUSTED_CLIENT_IP, so it goes
    // to the log and not to the caller.
    console.error(`admin/session: ${caller.reason}`);
    return json({ error: "This request could not be verified." }, { status: 400, headers: NO_STORE });
  }

  const gate = await checkAdminLoginGate(caller.ipHash);
  if (!gate.ok) {
    return backToAdmin("?error=locked", { "retry-after": String(gate.retryAfterSeconds) });
  }

  let submitted: string;
  try {
    submitted = String((await request.formData()).get("token") ?? "");
  } catch {
    return json({ error: "Expected a form submission." }, { status: 400, headers: NO_STORE });
  }

  const label = identifyToken(submitted);

  // Recorded before the answer is returned, success or failure: the count is
  // what the next attempt is measured against, and a failure that got away
  // without being written is a free guess.
  await recordLoginAttempt(caller.ipHash, label, label !== null);

  if (!label) return backToAdmin("?error=1");

  const session = await createAdminSession(label, caller.ipHash);

  return backToAdmin("", { "set-cookie": adminSetCookie(request, session.id, session.expiresAt) });
}

/** Signs out: revokes the session server-side, not just in the browser. */
export async function DELETE(request: Request): Promise<Response> {
  const raw = request.headers
    .get("cookie")
    ?.split(";")
    .map((part) => part.trim())
    .find((part) => part.startsWith(`${ADMIN_COOKIE}=`))
    ?.slice(ADMIN_COOKIE.length + 1);

  if (raw) {
    let id: string;
    try {
      id = decodeURIComponent(raw);
    } catch {
      id = raw;
    }
    // Revoked whether or not it currently resolves. A session that has already
    // expired, or belongs to a deployment whose token was cleared, still gets
    // its row marked rather than left live for a token that comes back.
    await resolveAdminSession(id);
    await revokeAdminSession(id);
  }

  // Clearing the browser's copy is the courtesy; the revocation above is the
  // part that holds if the browser ignores this.
  return json(
    { ok: true },
    {
      headers: {
        ...NO_STORE,
        "set-cookie": `${ADMIN_COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0`,
      },
    },
  );
}

/**
 * The session cookie.
 *
 * SameSite=Strict because nothing off-site should ever be able to drive an
 * admin action, not even a top-level navigation. Secure everywhere except
 * plain-HTTP localhost — derived from the request's own scheme rather than
 * NODE_ENV, so a staging deploy that forgot to set NODE_ENV does not ship the
 * session over the wire in clear.
 */
function adminSetCookie(request: Request, id: string, expiresAt: Date): string {
  const secure = requestIsHttps(request);
  return [
    `${ADMIN_COOKIE}=${encodeURIComponent(id)}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Strict",
    ...(secure ? ["Secure"] : []),
    `Expires=${expiresAt.toUTCString()}`,
  ].join("; ");
}

function requestIsHttps(request: Request): boolean {
  // x-forwarded-proto first: behind a TLS-terminating proxy the request URL's
  // own scheme is the plain-HTTP hop between proxy and app, and trusting it
  // would drop Secure on every production cookie.
  const forwarded = request.headers.get("x-forwarded-proto")?.split(",")[0]?.trim().toLowerCase();
  if (forwarded) return forwarded === "https";
  try {
    return new URL(request.url).protocol === "https:";
  } catch {
    return true; // cannot tell: the safe answer is the one that stays encrypted
  }
}

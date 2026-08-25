import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { painterCookieSecret, rateLimitSalt } from "../config";

/**
 * Who is painting, in the absence of accounts.
 *
 * A random id in a signed cookie. The signature is what makes it worth
 * anything: without it a caller mints a fresh identity per pixel and the
 * cooldown is decoration.
 *
 * The server stores only a salted hash of the id, never the id. Holding the
 * whole table is therefore not enough to forge a cookie, which is the
 * difference between a database leak and a database leak that hands somebody
 * unlimited paint.
 *
 * This is not a strong identity and is not meant to be one. It is one of two
 * keys — the other is the caller's address — and a paint has to satisfy both.
 */

export const PAINTER_COOKIE = "pw_painter";

/** Long enough that a returning visitor keeps their cooldown across a war. */
const COOKIE_MAX_AGE_SECONDS = 400 * 24 * 60 * 60;

function sign(id: string): string {
  return createHmac("sha256", painterCookieSecret()).update(id).digest("base64url");
}

export function painterKeyFor(id: string): string {
  return createHash("sha256").update(`${rateLimitSalt()}:painter:${id}`).digest("hex");
}

export function issuePainter(): { cookieValue: string; painterKey: string } {
  const id = randomBytes(16).toString("base64url");
  return { cookieValue: `${id}.${sign(id)}`, painterKey: painterKeyFor(id) };
}

/** The painter key carried by this request, or null if there is not a valid one. */
export function readPainter(request: Request): string | null {
  const raw = request.headers
    .get("cookie")
    ?.split(";")
    .map((part) => part.trim())
    .find((part) => part.startsWith(`${PAINTER_COOKIE}=`))
    ?.slice(PAINTER_COOKIE.length + 1);

  if (!raw) return null;

  // decodeURIComponent throws on a malformed escape — a cookie of "%" is
  // enough. This runs on every paint request, so it returns null like every
  // other rejection rather than turning a junk cookie into a 500.
  let decoded: string;
  try {
    decoded = decodeURIComponent(raw);
  } catch {
    return null;
  }

  const parts = decoded.split(".");
  if (parts.length !== 2) return null;

  const [id, signature] = parts;
  if (!id || !signature) return null;

  const expected = Buffer.from(sign(id));
  const offered = Buffer.from(signature);
  // Compare fixed-length digests: an early return on length would leak how
  // long the signature is.
  if (offered.length !== expected.length) return null;
  if (!timingSafeEqual(offered, expected)) return null;

  return painterKeyFor(id);
}

export function painterSetCookie(value: string): string {
  return [
    `${PAINTER_COOKIE}=${encodeURIComponent(value)}`,
    "Path=/",
    "HttpOnly",
    "Secure",
    "SameSite=Lax",
    `Max-Age=${COOKIE_MAX_AGE_SECONDS}`,
  ].join("; ");
}

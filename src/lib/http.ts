import { issuePainter, painterSetCookie, readPainter } from "./paint/painter";
import { clientIp, hashIp, subnetKey } from "./paint/client-ip";

/**
 * Who is calling, in one place.
 *
 * Fails closed on the address: without a trustworthy one there is no rate
 * limit, and a shared bucket for every anonymous caller is either an unlimited
 * allowance or a self-inflicted outage.
 */
export type Caller =
  | { ok: true; painterKey: string; ipHash: string; subnetKey: string; setCookie?: string }
  | { ok: false; message: string };

export function identify(request: Request): Caller {
  const identity = clientIp(request);
  if (!identity.ok) {
    // The operational detail (which env var to set, how many proxy hops are
    // configured) is for the server log, not the caller: it names
    // ALLOW_UNTRUSTED_CLIENT_IP, the variable that switches rate limiting
    // off, and this message is returned in a 400 body that the client
    // renders straight into the user's error pill.
    console.error(`identify: ${identity.reason}`);
    return {
      ok: false,
      message: "This request could not be verified. Please try again.",
    };
  }

  const existing = readPainter(request);
  if (existing) {
    return {
      ok: true,
      painterKey: existing,
      ipHash: hashIp(identity.ip),
      subnetKey: subnetKey(identity.ip),
    };
  }

  const issued = issuePainter();
  return {
    ok: true,
    painterKey: issued.painterKey,
    ipHash: hashIp(identity.ip),
    subnetKey: subnetKey(identity.ip),
    setCookie: painterSetCookie(issued.cookieValue),
  };
}

/**
 * The site's own origin, so a cross-site POST can be told apart from a
 * same-origin one.
 *
 * SITE_URL wins when it is set — the source of truth in production and
 * previews, where the Host header may not match the public hostname. Falling
 * back to the request's own Host keeps local development working without it.
 */
function siteOrigin(request: Request): string {
  const configured = process.env.SITE_URL?.trim();
  if (configured) {
    try {
      return new URL(configured).origin;
    } catch {
      // Malformed SITE_URL: fall through to Host rather than 500 every write.
    }
  }

  const host = request.headers.get("host");
  if (host) {
    const protocol = new URL(request.url).protocol || "https:";
    return `${protocol}//${host}`;
  }

  return new URL(request.url).origin;
}

/**
 * Refuses a POST that came from another site, or null to let it through.
 *
 * WHY EVERY WRITE ROUTE AND NOT JUST PAINTING. A CORS-simple POST (e.g.
 * `content-type: text/plain`) needs no preflight, so this is the only line
 * between any page on the internet and a state change made on this caller's
 * behalf. `SameSite=Lax` means such a request arrives cookieless, which
 * bounds the damage but does not remove it: a cookieless call still issues
 * challenges, opens orders and spends rate-limit budget, and the security
 * audit found the one endpoint where a forged write mattered more than that.
 *
 * A request with NO Origin header at all is unaffected — a same-origin form
 * post and a server-to-server call both look like that, and neither is what
 * this guard is for. Only a present, foreign Origin is refused.
 *
 * This lived inside `POST /api/paint` for a batch, which is why it reads as
 * an extraction rather than a new idea: one copy, called by every write.
 */
export function refuseForeignOrigin(request: Request): Response | null {
  const origin = request.headers.get("origin");
  if (!origin) return null;

  let foreign = true;
  try {
    foreign = new URL(origin).origin !== siteOrigin(request);
  } catch {
    foreign = true;
  }
  if (!foreign) return null;

  return json(
    { error: "This origin is not allowed to post here." },
    { status: 403, headers: NO_STORE },
  );
}

export const NO_STORE = { "cache-control": "no-store" };

export function json(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    ...init,
    headers: { "content-type": "application/json", ...(init.headers ?? {}) },
  });
}

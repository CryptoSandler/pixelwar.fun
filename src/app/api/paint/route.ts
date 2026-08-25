import { identify, json, NO_STORE } from "../../../lib/http";
import { paintPixel } from "../../../lib/paint/paint";
import { advanceWar, warBySlug } from "../../../lib/wars/lifecycle";

export const dynamic = "force-dynamic";

const STATUS: Record<string, number> = {
  war_not_live: 409,
  war_not_started: 409,
  cooldown: 429,
  banned: 403,
  unknown_token: 400,
  out_of_bounds: 400,
};

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
      // Malformed SITE_URL: fall through to Host rather than 500 every paint.
    }
  }

  const host = request.headers.get("host");
  if (host) {
    const protocol = new URL(request.url).protocol || "https:";
    return `${protocol}//${host}`;
  }

  return new URL(request.url).origin;
}

export async function POST(request: Request): Promise<Response> {
  // A CORS-simple POST (e.g. content-type: text/plain) needs no preflight, so
  // this is the only line standing between any page on the internet and
  // painting on this caller's behalf. SameSite=Lax means such a request
  // arrives cookieless, minting a fresh painter identity that gets charged
  // for the pixel — cross-site painting, silently, for whatever token the
  // attacker's page chose. A request with no Origin at all (a same-origin
  // form post, or a server-to-server call) is unaffected: it is allowed
  // through exactly as before.
  const origin = request.headers.get("origin");
  if (origin) {
    let foreign = true;
    try {
      foreign = new URL(origin).origin !== siteOrigin(request);
    } catch {
      foreign = true;
    }
    if (foreign) {
      return json(
        { error: "This origin is not allowed to paint here." },
        { status: 403, headers: NO_STORE },
      );
    }
  }

  const caller = identify(request);
  if (!caller.ok) return json({ error: caller.message }, { status: 400, headers: NO_STORE });

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return json({ error: "Body must be JSON" }, { status: 400, headers: NO_STORE });
  }

  const { warSlug, x, y, tokenId } = (body ?? {}) as Record<string, unknown>;
  if (
    typeof warSlug !== "string" ||
    typeof tokenId !== "string" ||
    typeof x !== "number" ||
    typeof y !== "number"
  ) {
    return json(
      { error: "warSlug and tokenId must be strings; x and y must be numbers" },
      { status: 400, headers: NO_STORE },
    );
  }

  const found = await warBySlug(warSlug);
  if (!found) return json({ error: "No such war" }, { status: 404, headers: NO_STORE });

  const result = await paintPixel({
    war: await advanceWar(found),
    x,
    y,
    tokenId,
    painterKey: caller.painterKey,
    ipHash: caller.ipHash,
    subnetKey: caller.subnetKey,
  });

  const cookie: Record<string, string> = caller.setCookie
    ? { "set-cookie": caller.setCookie }
    : {};

  if (!result.ok) {
    return json(
      { error: result.message, reason: result.reason },
      {
        status: STATUS[result.reason] ?? 400,
        headers: {
          ...NO_STORE,
          ...cookie,
          ...(result.retryAfterSeconds ? { "retry-after": String(result.retryAfterSeconds) } : {}),
        },
      },
    );
  }

  return json(result, { headers: { ...NO_STORE, ...cookie } });
}

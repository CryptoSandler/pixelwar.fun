import { identify, json, NO_STORE, refuseForeignOrigin } from "../../../lib/http";
import { paintPixel } from "../../../lib/paint/paint";
import { advanceWar, warBySlug } from "../../../lib/wars/lifecycle";

export const dynamic = "force-dynamic";

const STATUS: Record<string, number> = {
  war_not_live: 409,
  war_not_started: 409,
  cooldown: 429,
  banned: 403,
  // 402, not 403: the caller is not forbidden, they have not registered yet,
  // and the screen turns this exact status into the registration flow. The
  // ban above stays 403 so the two can never be confused — one is a door
  // that opens by paying and the other is not.
  not_registered: 402,
  unknown_token: 400,
  unknown_colour: 400,
  // 409, not 400: the request is well-formed and the caller is not confused
  // about the API — they are on the other side. A conflict is exactly what
  // this is.
  wrong_allegiance: 409,
  out_of_bounds: 400,
};

export async function POST(request: Request): Promise<Response> {
  // The guard this route used to carry inline, now shared by every write
  // endpoint — see `refuseForeignOrigin`. Cross-site painting was the case
  // that motivated it; the audit found five more routes that wanted it.
  const foreign = refuseForeignOrigin(request);
  if (foreign) return foreign;

  const caller = identify(request);
  if (!caller.ok) return json({ error: caller.message }, { status: 400, headers: NO_STORE });

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return json({ error: "Body must be JSON" }, { status: 400, headers: NO_STORE });
  }

  const { warSlug, x, y, tokenId, colourSlot } = (body ?? {}) as Record<string, unknown>;
  if (
    typeof warSlug !== "string" ||
    typeof tokenId !== "string" ||
    typeof x !== "number" ||
    typeof y !== "number" ||
    typeof colourSlot !== "number"
  ) {
    return json(
      {
        error:
          "warSlug and tokenId must be strings; x, y and colourSlot must be numbers",
      },
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
    // Range-checked in `paintPixel`, not here: it is the trust boundary that
    // touches the database, and a second copy of the bound here would be a
    // second thing to keep in step with the palette.
    colourSlot,
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

import { identify, json, NO_STORE } from "../../../lib/http";
import { paintPixel } from "../../../lib/paint/paint";
import { advanceWar, warBySlug } from "../../../lib/wars/lifecycle";

export const dynamic = "force-dynamic";

const STATUS: Record<string, number> = {
  war_not_live: 409,
  cooldown: 429,
  banned: 403,
  unknown_token: 400,
  out_of_bounds: 400,
};

export async function POST(request: Request): Promise<Response> {
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

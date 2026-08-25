import { changesSince } from "../../../lib/canvas/diff";
import { json } from "../../../lib/http";
import { advanceWar, warBySlug } from "../../../lib/wars/lifecycle";

export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
  const params = new URL(request.url).searchParams;
  const slug = params.get("war");
  const rawSince = params.get("since");
  if (!slug) return json({ error: "war is required" }, { status: 400 });

  // Digits only. `Number("")` is 0 and `Number(" 7 ")` is 7, so parsing first
  // and validating after quietly accepts a caller who sent nothing and serves
  // them the whole board's history as if they had asked for it. Anything past
  // the safe-integer range cannot be compared reliably either.
  const since = Number(rawSince);
  if (rawSince === null || !/^\d+$/.test(rawSince) || !Number.isSafeInteger(since)) {
    return json({ error: "since must be a non-negative integer" }, { status: 400 });
  }

  const found = await warBySlug(slug);
  if (!found) return json({ error: "No such war" }, { status: 404 });

  const result = await changesSince(await advanceWar(found), since);
  return json(result, {
    headers: { "cache-control": "public, s-maxage=1, stale-while-revalidate=2" },
  });
}

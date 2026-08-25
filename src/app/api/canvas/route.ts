import { canvasBytes } from "../../../lib/canvas/state";
import { json } from "../../../lib/http";
import { advanceWar, warBySlug } from "../../../lib/wars/lifecycle";

export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
  const slug = new URL(request.url).searchParams.get("war");
  if (!slug) return json({ error: "war is required" }, { status: 400 });

  const found = await warBySlug(slug);
  if (!found) return json({ error: "No such war" }, { status: 404 });

  const war = await advanceWar(found);
  const { seq, bytes } = await canvasBytes(war);

  return new Response(Buffer.from(bytes), {
    headers: {
      "content-type": "application/octet-stream",
      "x-canvas-seq": String(seq),
      "x-canvas-width": String(war.width),
      "x-canvas-height": String(war.height),
      // "ended" is not actually forever: an operator can extend a war after
      // the fact, and a later batch changes what this endpoint returns for
      // one. A year-long immutable response cannot be recalled once a client
      // has cached it, so an ended board gets a short cache instead of a
      // permanent one — long enough to matter, short enough to recover from.
      "cache-control":
        war.status === "ended"
          ? "public, max-age=60"
          : "public, s-maxage=2, stale-while-revalidate=8",
    },
  });
}

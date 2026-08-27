import { canvasBytes, type CanvasLayer } from "../../../lib/canvas/state";
import { json } from "../../../lib/http";
import { advanceWar, warBySlug } from "../../../lib/wars/lifecycle";

export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
  const params = new URL(request.url).searchParams;
  const slug = params.get("war");
  if (!slug) return json({ error: "war is required" }, { status: 400 });

  // Anything that is not the territory layer is the painted board. An unknown
  // value falls back rather than 400ing: the default layer is always a
  // truthful answer to "show me the board", so a typo costs a wrong view, not
  // a broken one.
  const layer: CanvasLayer = params.get("layer") === "token" ? "token" : "colour";

  const found = await warBySlug(slug);
  if (!found) return json({ error: "No such war" }, { status: 404 });

  const war = await advanceWar(found);
  const { seq, bytes } = await canvasBytes(war, layer);

  return new Response(Buffer.from(bytes), {
    headers: {
      "content-type": "application/octet-stream",
      "x-canvas-seq": String(seq),
      "x-canvas-width": String(war.width),
      "x-canvas-height": String(war.height),
      "x-canvas-layer": layer,
      // "ended" is not actually forever: an operator can extend a war after
      // the fact. That used to be a possibility this comment anticipated;
      // `reviveWar` in lifecycle.ts is the transition that makes it real, so
      // the sixty seconds below is now the only thing standing between a
      // revived war and a client showing a board that stopped changing.
      //
      // A year-long immutable response cannot be recalled once a client has
      // cached it, so an ended board gets a short cache instead of a
      // permanent one — long enough to matter, short enough to recover from.
      // Raising it is the change that needs an argument; lowering it is
      // always safe. `canvas-cache.test.ts` holds the ceiling.
      "cache-control":
        war.status === "ended"
          ? "public, max-age=60"
          : "public, s-maxage=2, stale-while-revalidate=8",
    },
  });
}

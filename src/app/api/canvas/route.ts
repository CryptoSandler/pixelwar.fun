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
      // An ended board cannot change; a live one may, twice a second at most.
      "cache-control":
        war.status === "ended"
          ? "public, max-age=31536000, immutable"
          : "public, s-maxage=2, stale-while-revalidate=8",
    },
  });
}

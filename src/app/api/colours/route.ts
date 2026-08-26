import { json, NO_STORE } from "../../../lib/http";
import { freeColours } from "../../../lib/payments/orders";
import { warBySlug } from "../../../lib/wars/lifecycle";

export const dynamic = "force-dynamic";

/**
 * The colour slots a war has no live claim on.
 *
 * `freeColours` already existed for the paths that tell a payer what is left
 * after a failure; nothing exposed it before anyone had chosen. A colour
 * picker that cannot enumerate colours is not a colour picker, so the entry
 * flow needs this.
 *
 * `no-store`, not a short cache: two people choosing the same colour ten
 * seconds apart is the normal case this endpoint exists inside, and a cached
 * answer would hand the second one a slot that is already gone. The
 * authority on who gets a colour is still the partial unique index behind
 * `createOrder` — this endpoint only decides what is worth offering.
 */
export async function GET(request: Request): Promise<Response> {
  const slug = new URL(request.url).searchParams.get("war");
  if (!slug) return json({ error: "war is required" }, { status: 400, headers: NO_STORE });

  const war = await warBySlug(slug);
  if (!war) return json({ error: "No such war" }, { status: 404, headers: NO_STORE });

  return json({ free: await freeColours(war.id) }, { headers: NO_STORE });
}

import { adminConfigured, authenticateAdmin } from "./admin";
import { json, NO_STORE } from "./http";

/**
 * One guard, one answer, for every admin route.
 *
 * The rule this file exists to make unbreakable: **an unauthenticated request
 * must get the same answer as a wrong token.** No cookie, an expired cookie, a
 * revoked cookie, a malformed cookie, a wrong `x-admin-token`, and a
 * deployment with `ADMIN_TOKEN` unset all produce the identical response —
 * same status, same body, same headers. A response that distinguishes "no
 * session" from "bad session" tells a prober which half of the surface to
 * attack, and that distinction is easy to reintroduce by accident once each
 * route writes its own refusal. So no route writes its own.
 *
 * Deliberately NOT the sign-in route's 503-for-unconfigured. That route has to
 * tell an operator standing in front of it why the form does not work; these
 * routes have no such duty, and "this deployment has no admin surface" is
 * exactly the kind of thing a prober is trying to establish. The operator
 * learns it from the server log instead, which is where configuration faults
 * belong.
 *
 * Deliberately a separate file from `admin.ts`: that module is Task 1's, was
 * adapted line by line from a hardened source, and knows nothing about HTTP
 * responses. This is the HTTP shell around it.
 *
 * WHO CALLS THIS: `GET /api/admin/orphans` and
 * `POST /api/admin/orphans/[id]/assign`. Every admin route added after them
 * must call it too — that is the point of it being one function.
 */

/** The single refusal. Every failure mode returns exactly this. */
export function adminRefusal(): Response {
  return json({ error: "Not authorised." }, { status: 401, headers: NO_STORE });
}

export type AdminGuard =
  | { ok: true; label: string }
  | { ok: false; response: Response };

/**
 * `surface` names the route in the server log when `ADMIN_TOKEN` is unset. It
 * never reaches the caller — nothing about the refusal varies, by design.
 */
export async function requireAdmin(request: Request, surface: string): Promise<AdminGuard> {
  // Fails closed. An unset ADMIN_TOKEN means this deployment has no admin
  // surface, not that the admin surface is open to everybody — so a request
  // carrying what would have been the right token is refused with the rest.
  if (!adminConfigured()) {
    console.error(`${surface}: ADMIN_TOKEN is not set; refusing every request.`);
    return { ok: false, response: adminRefusal() };
  }

  const identity = await authenticateAdmin(request);
  if (!identity.ok) return { ok: false, response: adminRefusal() };

  return { ok: true, label: identity.label };
}

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

/**
 * Wall time a refusal takes, whatever produced it.
 *
 * The response body, status and headers were already identical across every
 * failure. The clock was not. An unconfigured deployment refuses after **zero**
 * database round trips; a configured one refuses a wrong `x-admin-token` after
 * four — the lockout SELECT, the attempt INSERT, and two prune DELETEs. So the
 * latency answered a question the body refused to: *does this deployment have
 * an admin surface at all*. That is reconnaissance rather than a break-in, but
 * it is the question a prober asks first, and the whole point of this file is
 * that a refusal tells them nothing.
 *
 * Note what this is NOT fixing. The token comparison is already constant-time:
 * `identifyToken` hashes both sides to 32 bytes and checks every configured
 * token without breaking on a match. The leak was never in the comparison, and
 * a "constant-time compare" here would have been a fix aimed at the wrong
 * thing, arriving with a test that passed for the wrong reason.
 *
 * 250ms comfortably exceeds four Neon round trips from a Vercel region, and is
 * imperceptible to an operator who has just been refused.
 */
export const REFUSAL_FLOOR_MS = 250;

/**
 * Holds a refusal until `REFUSAL_FLOOR_MS` has passed since the request
 * arrived, then returns it.
 *
 * **A floor, not a constant.** It closes the gap in one direction only: a path
 * that already took longer than the floor is returned immediately rather than
 * padded further, so an unusually slow database still stands out to an attacker
 * measuring carefully. Padding to `floor + elapsed` instead would make every
 * refusal carry the variance it was meant to hide, which is worse. Eliminating
 * the signal entirely would mean making the unconfigured path do the same
 * database work — which means writing login-attempt rows on a deployment that
 * has no admin surface, for anyone who sends a request. That trade is not worth
 * it, and this comment exists so the next reader can re-make that judgement
 * rather than assume nobody thought about it.
 */
export async function holdRefusal(startedAtMs: number): Promise<Response> {
  const remaining = REFUSAL_FLOOR_MS - (Date.now() - startedAtMs);
  if (remaining > 0) await new Promise((resolve) => setTimeout(resolve, remaining));
  return adminRefusal();
}

export type AdminGuard =
  | { ok: true; label: string }
  | { ok: false; response: Response };

/**
 * `surface` names the route in the server log when `ADMIN_TOKEN` is unset. It
 * never reaches the caller — nothing about the refusal varies, by design.
 */
export async function requireAdmin(request: Request, surface: string): Promise<AdminGuard> {
  // Taken before anything branches, so every refusal below is measured from the
  // same instant — see `holdRefusal`.
  const startedAtMs = Date.now();

  // Fails closed. An unset ADMIN_TOKEN means this deployment has no admin
  // surface, not that the admin surface is open to everybody — so a request
  // carrying what would have been the right token is refused with the rest.
  if (!adminConfigured()) {
    console.error(`${surface}: ADMIN_TOKEN is not set; refusing every request.`);
    return { ok: false, response: await holdRefusal(startedAtMs) };
  }

  const identity = await authenticateAdmin(request);
  if (!identity.ok) return { ok: false, response: await holdRefusal(startedAtMs) };

  // Success is deliberately not floored. A caller who authenticated already
  // holds the secret, so there is nothing left for the clock to tell them, and
  // delaying every legitimate admin request to hide nothing is pure cost.
  return { ok: true, label: identity.label };
}

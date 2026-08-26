import { createHash, timingSafeEqual } from "node:crypto";
import { json, NO_STORE } from "../../../../lib/http";
import { expireStaleOrders } from "../../../../lib/payments/orders";
import { recoverUnclaimedOrders } from "../../../../lib/payments/recover";

export const dynamic = "force-dynamic";

/**
 * The trigger for recovery.
 *
 * Expiry is lazy — `freeColours` and `createOrder` run it themselves, so no
 * route can forget to (see `orders.ts`). Recovery cannot be: it makes RPC
 * calls, one per candidate signature, against a rate-limited endpoint shared
 * with every live checkout. Hanging that off a payer's request would make
 * somebody else's checkout pay for it, in latency and in quota. So it gets
 * its own trigger, called on a schedule from outside — see
 * `.github/workflows/reconcile.yml`, which is a GitHub Actions workflow
 * rather than Vercel Cron for the reason this route's guard implies: Vercel
 * Cron cannot send a request header.
 *
 * It also expires before it recovers, because recovery's candidate set is
 * something expiry produces and lazy expiry only produces it when the site
 * has visitors. The call site below has the full argument.
 *
 * POST, not GET: this mutates. `entry_orders` rows change status, colours are
 * reclaimed, `unmatched_payments` rows are filed.
 */

/**
 * Whether the caller presented the shared secret.
 *
 * Both sides are hashed before the comparison, for two reasons.
 * `timingSafeEqual` throws outright on buffers of different lengths, so a
 * raw comparison would need a length check first — and that check is itself
 * an oracle, answering "how long is the secret" one guess at a time. SHA-256
 * digests are always 32 bytes, so the comparison is constant-time across
 * every input, including inputs of the wrong length, and leaks nothing about
 * the expected value.
 */
function presentedSecret(provided: string, expected: string): boolean {
  const a = createHash("sha256").update(provided, "utf8").digest();
  const b = createHash("sha256").update(expected, "utf8").digest();
  return timingSafeEqual(a, b);
}

export async function POST(request: Request): Promise<Response> {
  const expected = process.env.CRON_SECRET?.trim();

  // Fails closed, and deliberately so. An unset secret means this deployment
  // was never configured to run reconciliation, not that reconciliation is
  // open to everybody: the alternative — run unguarded when unconfigured —
  // turns one missing environment variable into a public endpoint that spends
  // the RPC quota of every checkout in flight, on demand, for anyone who
  // finds the path. 503 rather than 401 because the fault is this
  // deployment's, not the caller's.
  if (!expected) {
    console.error("cron/reconcile: CRON_SECRET is not set; refusing every request.");
    return json({ error: "Reconciliation is not configured." }, { status: 503, headers: NO_STORE });
  }

  const provided = request.headers.get("x-cron-secret") ?? "";
  if (!presentedSecret(provided, expected)) {
    return json({ error: "Unauthorized." }, { status: 401, headers: NO_STORE });
  }

  // Expiry runs here too, and this is NOT a redundant third copy of the call
  // in `freeColours` and `createOrder` — it is the one that makes this route
  // work at all. Read the dependency before deleting it:
  //
  // `recoverUnclaimedOrders` selects on `status = 'expired'`. Nothing in this
  // system sets that status except `expireStaleOrders`, and the other two call
  // sites are LAZY — they run only when somebody loads the colour picker or
  // opens an order. So without this line, the recovery pass's input is
  // produced by site traffic, and a pass that lands when nobody is browsing
  // finds an empty candidate set and returns zero however many payments are
  // actually sitting there unrecovered.
  //
  // That is exactly backwards. Recovery exists for the payer who signed a
  // transfer and closed the tab — the case where nobody is watching. A
  // recovery pass that only works while the site is busy does not cover the
  // case it was built for. One extra query per pass buys this route its own
  // input, so it depends on its schedule and nothing else.
  await expireStaleOrders();

  const { recovered, filed } = await recoverUnclaimedOrders();

  // Counts, not ids. An order id is the handle on somebody's payment, and
  // this response leaves the deployment for a CI log that is retained for
  // ninety days and, on a public repository, is world-readable. The numbers
  // are what a schedule needs to know; the ids are in the database.
  return json(
    { recovered: recovered.length, filed: filed.length },
    { headers: NO_STORE },
  );
}

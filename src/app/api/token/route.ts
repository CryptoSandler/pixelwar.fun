import { identify, json, NO_STORE } from "../../../lib/http";
import { validateAddress } from "../../../lib/tokens/addresses";
import { dexscreenerTokenUrl, isChainId } from "../../../lib/tokens/chains";
import { resolveToken } from "../../../lib/tokens/dexscreener";

export const dynamic = "force-dynamic";

/**
 * What a contract address actually resolves to, before anybody pays for it.
 *
 * `POST /api/orders` resolves the same token itself and refuses an address no
 * DEX has heard of, so a typo can never become an order. That is not enough
 * on its own: an address can be real, resolve cleanly, and belong to a
 * different token than the one whose community is paying — and by then the
 * order has already reserved a colour. This endpoint is what lets the entry
 * flow put the name, ticker and logo on screen while the choice is still
 * free to change.
 *
 * Read-only and creates nothing. The order route remains the only thing that
 * reserves anything.
 */

/**
 * A defensive bound on `contract`, checked before it reaches an address
 * decoder — the same reasoning, and the same limit, as `POST /api/orders`.
 */
const MAX_RAW_ADDRESS_LENGTH = 128;

/**
 * Lookups allowed per `ip_hash` inside the window below.
 *
 * A function, not a constant, for the same reason as `orderRateLimit` in
 * `orders/route.ts`: a module-level constant freezes the value at import
 * time, which a test cannot then dial down without a process restart.
 */
function tokenRateLimit(): { max: number; windowMs: number } {
  const max = Number.parseInt(process.env.TOKEN_RATE_LIMIT_MAX ?? "", 10);
  const windowSeconds = Number.parseInt(process.env.TOKEN_RATE_LIMIT_WINDOW_SECONDS ?? "", 10);
  return {
    max: Number.isInteger(max) && max > 0 ? max : 30,
    windowMs: (Number.isInteger(windowSeconds) && windowSeconds > 0 ? windowSeconds : 60) * 1000,
  };
}

/**
 * In-memory rather than the DB-backed pattern `tooManyOrders` uses, for the
 * reason `/api/rpc` gives for the same choice: starting an order is a rare,
 * deliberate act worth a database round trip to count precisely, while a
 * preview happens every time somebody corrects a pasted address. What this
 * protects is a third party's API — DexScreener's — from being reached
 * through us at a rate we would not ask of it ourselves. `resolveToken`
 * already caches for a minute, so a caller retrying one address costs
 * nothing upstream; this bounds a caller sweeping many.
 *
 * The trade it accepts is the same one, too: the bucket resets on a cold
 * start and is per instance rather than shared.
 */
const buckets = new Map<string, { count: number; windowStart: number }>();

/** Bounds `buckets`' size by sweeping windows that have already lapsed. */
function pruneStaleBuckets(windowMs: number, now: number): void {
  if (buckets.size < 5_000) return;
  for (const [key, bucket] of buckets) {
    if (now - bucket.windowStart >= windowMs) buckets.delete(key);
  }
}

function tooManyLookups(ipHash: string): boolean {
  const { max, windowMs } = tokenRateLimit();
  const now = Date.now();
  pruneStaleBuckets(windowMs, now);

  const bucket = buckets.get(ipHash);
  if (!bucket || now - bucket.windowStart >= windowMs) {
    buckets.set(ipHash, { count: 1, windowStart: now });
    return false;
  }
  bucket.count += 1;
  return bucket.count > max;
}

export async function GET(request: Request): Promise<Response> {
  const params = new URL(request.url).searchParams;
  const chainId = params.get("chain");
  const contract = params.get("contract");

  if (!chainId || !contract) {
    return json({ error: "chain and contract are required." }, { status: 400, headers: NO_STORE });
  }
  if (!isChainId(chainId)) {
    return json({ error: "That chain is not supported." }, { status: 400, headers: NO_STORE });
  }
  if (contract.length > MAX_RAW_ADDRESS_LENGTH) {
    return json(
      { error: `contract must be at most ${MAX_RAW_ADDRESS_LENGTH} characters.` },
      { status: 400, headers: NO_STORE },
    );
  }

  const caller = identify(request);
  if (!caller.ok) return json({ error: caller.message }, { status: 400, headers: NO_STORE });
  const cookie: Record<string, string> = caller.setCookie
    ? { "set-cookie": caller.setCookie }
    : {};

  // Shape-checked before the lookup it exists to save: an address that is not
  // an address for this chain cannot resolve, and asking DexScreener about it
  // spends a round trip to learn what `validateAddress` already knows.
  const checked = validateAddress(chainId, contract);
  if (!checked.ok) {
    return json({ error: checked.reason }, { status: 400, headers: { ...NO_STORE, ...cookie } });
  }

  // Rate-limited after the free checks and before the paid one, never after:
  // there is no quota left to save once the upstream call already happened.
  if (tooManyLookups(caller.ipHash)) {
    return json(
      { error: "Too many token lookups from this address. Try again shortly." },
      { status: 429, headers: { ...NO_STORE, ...cookie } },
    );
  }

  const resolved = await resolveToken(chainId, checked.canonical);
  if (!resolved.ok) {
    const status = resolved.kind === "not_found" ? 404 : 503;
    return json({ error: resolved.message }, { status, headers: { ...NO_STORE, ...cookie } });
  }

  return json(
    {
      chainId,
      contract: checked.display,
      name: resolved.metadata.name,
      ticker: resolved.metadata.ticker,
      logoUrl: resolved.metadata.logoUrl ?? null,
      links: resolved.metadata.links,
      sourceUrl: resolved.metadata.sourceUrl ?? dexscreenerTokenUrl(chainId, checked.display),
    },
    { headers: { ...NO_STORE, ...cookie } },
  );
}

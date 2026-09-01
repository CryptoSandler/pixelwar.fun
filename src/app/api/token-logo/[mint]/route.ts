import { fetchTokenLogo } from "../../../../lib/tokens/logo-source";

/**
 * A token's logo, served from our own origin.
 *
 * WHY THIS ROUTE EXISTS, and it is a privacy answer before it is a security
 * one. `JoinFlow` puts a third party's URL straight into an `<img src>`, so
 * every visitor's browser announces itself to whatever host that token's
 * deployer chose. `dexscreener.ts` already refuses any image host but
 * DexScreener's CDN and says exactly why — "a tracking beacon on our
 * audience" — and that refusal is the reason most tokens have no logo at all.
 * Widening the sources without widening the exposure means the bytes come
 * from us. This is the same shape of fix `/api/rpc` is: nothing of the
 * upstream reaches the browser.
 *
 * THE MINT IS THE ONLY INPUT, AND IT IS NOT A URL. A caller names a token;
 * every URL involved is one this server derived — from the token's own
 * Metaplex account, from Jupiter, or from DexScreener. There is no parameter
 * anywhere in this pipeline that a caller can point at a host of their
 * choosing, which is what keeps this from being an open proxy with a cache in
 * front of it.
 *
 * NO LOGO IS A 404 AND THAT IS THE DESIGNED OUTCOME, not a failure. The
 * scoreboard falls back to the token's flag colour, which is what it shows
 * today for every token in production. A token whose logo is an SVG, or lives
 * on a host we do not fetch from, is a token with a flag.
 */

export const dynamic = "force-dynamic";

/** A Solana mint is 32 bytes of base58. Nothing else gets past the front door. */
const MINT = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

/**
 * How long a hit is kept, in this instance and in the CDN.
 *
 * A logo changes when a project rebrands, which is a thing that happens on
 * the scale of months. An hour in the browser and a day at the edge means a
 * busy war costs a handful of upstream fetches per deployment rather than one
 * per visitor, and a rebrand still lands within a day without anybody
 * deploying.
 */
const HIT_TTL_MS = 60 * 60 * 1000;

/**
 * How long "this token has no logo" is remembered.
 *
 * SHORTER THAN A HIT, AND IT IS THE MORE IMPORTANT OF THE TWO. Without it,
 * every render of a token that has no logo re-asks three upstreams —
 * including an RPC call — and the tokens with no logo are the majority. A
 * negative cache is what stops the common case being the expensive one. It is
 * shorter than a hit because a token acquiring a logo is a thing worth
 * noticing sooner than a token changing one.
 */
const MISS_TTL_MS = 10 * 60 * 1000;

/**
 * The most entries kept in one instance.
 *
 * A BOUND, because this is a serverless instance's heap and the keys come
 * from callers. At 512KB an entry the cap is the real ceiling on what this
 * route can hold; the count is what stops a stream of unknown mints from
 * being an easy way to grow it. Oldest-inserted is evicted first — a plain
 * Map iterates in insertion order, which is an LRU's cheaper cousin and
 * enough for a cache whose entries all expire on a timer anyway.
 */
const MAX_ENTRIES = 256;

/**
 * Upstream fetches allowed per minute, per instance.
 *
 * ON MISSES, NOT ON REQUESTS. A hit costs nothing upstream and must never be
 * refused — rate-limiting served bytes would punish a busy war for being
 * busy. What needs a ceiling is the number of strangers' hosts this server
 * will dial per minute, and that is exactly the miss path.
 *
 * IN MEMORY, NOT IN THE DATABASE. Every other limit in this project is a
 * table because it guards money or the board. This guards outbound fetches,
 * and a database write per image request would cost more than the thing it
 * protects. Per instance is the right unit too: the fetches it bounds are the
 * ones this instance makes.
 */
const MISSES_PER_MINUTE = 60;

type Entry = { at: number; body: { bytes: Buffer; contentType: string } | null };

type Store = { cache: Map<string, Entry>; window: { start: number; count: number } };

// Hung off globalThis so a hot instance keeps its cache across invocations,
// the same trick `dexscreener.ts` uses for the same reason.
const globalRef = globalThis as typeof globalThis & { __logoStore?: Store };

function store(): Store {
  globalRef.__logoStore ??= { cache: new Map(), window: { start: 0, count: 0 } };
  return globalRef.__logoStore;
}

function remember(key: string, body: Entry["body"]): void {
  const { cache } = store();
  cache.delete(key);
  cache.set(key, { at: Date.now(), body });
  // Insertion order, so the first key is the oldest.
  while (cache.size > MAX_ENTRIES) {
    const oldest = cache.keys().next();
    if (oldest.done) break;
    cache.delete(oldest.value);
  }
}

function recall(key: string): Entry | null {
  const entry = store().cache.get(key);
  if (!entry) return null;
  const ttl = entry.body ? HIT_TTL_MS : MISS_TTL_MS;
  if (Date.now() - entry.at > ttl) {
    store().cache.delete(key);
    return null;
  }
  return entry;
}

/** True when this instance may dial one more upstream in the current minute. */
function mayFetch(): boolean {
  const { window } = store();
  const now = Date.now();
  if (now - window.start > 60_000) {
    window.start = now;
    window.count = 0;
  }
  if (window.count >= MISSES_PER_MINUTE) return false;
  window.count += 1;
  return true;
}

function noLogo(status = 404): Response {
  return new Response(null, {
    status,
    headers: {
      // Cached as an answer, because "no logo" is the common case and is
      // stable. Shorter than a hit for the reason MISS_TTL_MS gives.
      "cache-control": "public, max-age=600, s-maxage=600",
    },
  });
}

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ mint: string }> },
): Promise<Response> {
  const { mint } = await params;

  // Shape first, and nothing else happens until it passes. A mint that is not
  // a mint cannot cost an RPC call, a cache entry or a rate-limit slot.
  if (!MINT.test(mint)) return noLogo(400);

  const cached = recall(mint);
  if (cached) return cached.body ? serve(cached.body) : noLogo();

  // Refused rather than queued: a logo is decoration, and a visitor waiting
  // behind a rate limit for one is a worse page than a flag. 404 rather than
  // 429 on purpose — the client's answer to both is identical, and a 429
  // would invite a retry loop for something nobody is waiting on.
  if (!mayFetch()) return noLogo();

  const found = await fetchTokenLogo(mint);
  if (!found.ok) {
    remember(mint, null);
    return noLogo();
  }

  const body = { bytes: found.image.bytes, contentType: found.image.contentType };
  remember(mint, body);
  return serve(body);
}

function serve(body: { bytes: Buffer; contentType: string }): Response {
  return new Response(new Uint8Array(body.bytes), {
    headers: {
      // OUR TYPE, FROM OUR SNIFF. Never the upstream's header: verifying by
      // magic bytes and then forwarding somebody else's Content-Type would be
      // measuring one thing and publishing another.
      "content-type": body.contentType,
      "content-length": String(body.bytes.length),
      "cache-control": "public, max-age=3600, s-maxage=86400, immutable",
      // The bytes were sniffed and are one of four raster formats, but this
      // costs nothing and closes the gap if a fifth is ever added carelessly.
      "x-content-type-options": "nosniff",
      // Nothing about the upstream travels with the response: no host, no
      // URL, no source name. A header naming which of the three answered
      // would undo the point of proxying for anybody watching a network tab.
    },
  });
}

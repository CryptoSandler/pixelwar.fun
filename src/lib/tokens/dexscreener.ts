import { getChain, type Chain } from "./chains";
import { normalizeLink, normalizeXHandle } from "./links";

/**
 * A minimal slice of the sibling project's `EntryLinks` type: just the social
 * fields this module can fill in from DexScreener's `info` block.
 */
export type EntryLinks = {
  website?: string;
  x?: string;
  telegram?: string;
  discord?: string;
};

/**
 * Canonical token metadata, read from DexScreener rather than typed by
 * whoever is paying.
 *
 * This is what stops a buyer from owning an entry's identity: name, ticker
 * and logo all come from the chain's own market data, so paying for an entry
 * cannot rewrite what it says. It also doubles as the existence check — an
 * address no DEX has ever seen cannot be listed.
 */
export type TokenMetadata = {
  name: string;
  ticker: string;
  logoUrl?: string;
  /** DexScreener's banner, when the token has one. Most do not. */
  bannerUrl?: string;
  links: EntryLinks;
  /** DexScreener's own page for the pair we read, kept for attribution. */
  sourceUrl?: string;
  fetchedAt: string;
};

export type MetadataResult =
  | { ok: true; metadata: TokenMetadata }
  | { ok: false; kind: "not_found" | "unavailable"; message: string };

type DexPair = {
  chainId?: string;
  url?: string;
  baseToken?: { address?: string; name?: string; symbol?: string };
  liquidity?: { usd?: number };
  info?: {
    imageUrl?: string;
    /** DexScreener's banner for the token, 1500x500 on its own CDN. */
    header?: string;
    websites?: { label?: string; url?: string }[];
    socials?: { type?: string; url?: string }[];
  };
};

const ENDPOINT = "https://api.dexscreener.com";
const TIMEOUT_MS = 8_000;
const CACHE_TTL_MS = 60_000;

/** DexScreener serves token images from its own CDN. */
const IMAGE_HOSTS = ["dexscreener.com", "cdn.dexscreener.com"];

type CacheEntry = { at: number; result: MetadataResult };
const globalRef = globalThis as unknown as { __dexCache?: Map<string, CacheEntry> };
function cache(): Map<string, CacheEntry> {
  globalRef.__dexCache ??= new Map();
  return globalRef.__dexCache;
}

function sameAddress(a: string, b: string): boolean {
  // EVM addresses are case-insensitive; Solana, TON and TRON are not, and
  // lowercasing those would make two different accounts compare equal.
  if (a.startsWith("0x") && b.startsWith("0x")) return a.toLowerCase() === b.toLowerCase();
  return a === b;
}

/**
 * DexScreener returns pairs, and the token we asked about is not always the
 * pair's base token — query one and the top pair can come back with USDC as
 * base. Reading baseToken blindly would list the wrong token's name and logo,
 * so only pairs where our address IS the base token can describe it.
 */
function pickPair(pairs: DexPair[], chain: Chain, address: string): DexPair | null {
  const candidates = pairs.filter(
    (pair) =>
      pair.chainId === chain.dexscreenerId &&
      pair.baseToken?.address &&
      sameAddress(pair.baseToken.address, address),
  );
  if (candidates.length === 0) return null;

  // Prefer a pair that actually carries an info block, then the deepest one:
  // the most liquid pair tends to be the one with curated metadata.
  return candidates.sort((a, b) => {
    const infoScore = (pair: DexPair) =>
      (pair.info?.imageUrl ? 2 : 0) + (pair.info?.socials?.length ? 1 : 0);
    const byInfo = infoScore(b) - infoScore(a);
    if (byInfo !== 0) return byInfo;
    return (b.liquidity?.usd ?? 0) - (a.liquidity?.usd ?? 0);
  })[0];
}

function safeImage(imageUrl?: string): string | undefined {
  if (!imageUrl) return undefined;
  let url: URL;
  try {
    url = new URL(imageUrl);
  } catch {
    return undefined;
  }
  const host = url.hostname.toLowerCase().replace(/^www\./, "");
  // Only DexScreener's own CDN. Any other host would be an image we serve to
  // every visitor from a domain a third party controls — a tracking beacon on
  // our audience. Note these URLs need their query string (sizing), so they
  // deliberately do not go through the link normalizer.
  if (!IMAGE_HOSTS.some((allowed) => host === allowed || host.endsWith(`.${allowed}`))) {
    return undefined;
  }
  return url.protocol === "https:" ? url.toString() : undefined;
}

/**
 * Social links still go through our own hygiene rules — DexScreener is a
 * trusted source for *which* links belong to a token, not for whether those
 * links are ones we accept. A link that fails is dropped, not fatal: bad
 * socials should never block a paid entry.
 */
function extractLinks(pair: DexPair): EntryLinks {
  const links: EntryLinks = {};

  const website = pair.info?.websites?.find((site) => site.url)?.url;
  if (website) {
    const checked = normalizeLink(website, "website");
    if (checked.ok) links.website = checked.url;
  }

  for (const social of pair.info?.socials ?? []) {
    if (!social.url) continue;
    const type = (social.type ?? "").toLowerCase();

    if (type === "twitter" || type === "x") {
      const checked = normalizeXHandle(social.url);
      if (checked.ok) links.x ??= checked.url;
    } else if (type === "telegram") {
      const checked = normalizeLink(social.url, "telegram");
      if (checked.ok) links.telegram ??= checked.url;
    } else if (type === "discord") {
      const checked = normalizeLink(social.url, "discord");
      if (checked.ok) links.discord ??= checked.url;
    }
  }

  return links;
}

/**
 * The shape of `fetch` this module actually needs, kept narrow so a test can
 * fabricate a response without constructing a real `Response`.
 */
export type TokenFetch = (
  url: string,
  init: { headers: Record<string, string>; signal: AbortSignal; cache: RequestCache },
) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

const defaultFetch: TokenFetch = (url, init) => fetch(url, init);

async function getJson(fetchImpl: TokenFetch, url: string): Promise<unknown> {
  const response = await fetchImpl(url, {
    headers: { accept: "application/json" },
    signal: AbortSignal.timeout(TIMEOUT_MS),
    cache: "no-store",
  });
  if (!response.ok) throw new Error(`DexScreener responded ${response.status}`);
  return response.json();
}

/**
 * Resolves a chain + contract address to the token's canonical identity, or
 * explains why it could not: an unknown chain, an address no DEX has ever
 * seen, or DexScreener being unreachable.
 *
 * `fetchImpl` is injectable so every test fabricates its own DexScreener
 * response instead of reaching the real API — the default just wraps the
 * global `fetch`.
 */
export async function resolveToken(
  chainId: string,
  address: string,
  fetchImpl: TokenFetch = defaultFetch,
): Promise<MetadataResult> {
  const chain = getChain(chainId);
  if (!chain) {
    return { ok: false, kind: "not_found", message: `Unknown chain: ${chainId}.` };
  }

  const key = `${chain.id}:${address}`;
  const hit = cache().get(key);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.result;

  let result: MetadataResult;
  try {
    // The chain-scoped endpoint proves the token trades on THIS chain, which
    // the cross-chain endpoint cannot: query PEPE and you get Ethereum and
    // PulseChain pairs together.
    const scoped = (await getJson(
      fetchImpl,
      `${ENDPOINT}/tokens/v1/${chain.dexscreenerId}/${encodeURIComponent(address)}`,
    )) as DexPair[] | null;

    let pair = pickPair(Array.isArray(scoped) ? scoped : [], chain, address);

    // That endpoint returns a single pair, and it may be one where our token is
    // the quote side. Fall back to the wider lookup, still filtered by chain.
    if (!pair) {
      const wide = (await getJson(
        fetchImpl,
        `${ENDPOINT}/latest/dex/tokens/${encodeURIComponent(address)}`,
      )) as { pairs?: DexPair[] | null };
      pair = pickPair(wide?.pairs ?? [], chain, address);
    }

    if (!pair) {
      result = {
        ok: false,
        kind: "not_found",
        message: `Token not found on any DEX for ${chain.name}. Check the address and the chain. A token has to be trading somewhere before it can be listed.`,
      };
    } else {
      const name = pair.baseToken?.name?.trim();
      const ticker = pair.baseToken?.symbol?.trim();

      if (!name || !ticker) {
        // Never fabricate an identity. An entry with no name is not an entry.
        result = {
          ok: false,
          kind: "not_found",
          message: `DexScreener knows this address but has no name or ticker for it, so it cannot be listed yet.`,
        };
      } else {
        result = {
          ok: true,
          metadata: {
            name,
            ticker: ticker.toUpperCase(),
            logoUrl: safeImage(pair.info?.imageUrl),
            bannerUrl: safeImage(pair.info?.header),
            links: extractLinks(pair),
            sourceUrl: pair.url,
            fetchedAt: new Date().toISOString(),
          },
        };
      }
    }
  } catch {
    // Timeouts, network failures and non-200s all land here. We fail the
    // lookup rather than create an entry with empty metadata — a nameless row
    // on a paid leaderboard is worse than a rejected payment.
    result = {
      ok: false,
      kind: "unavailable",
      message:
        "Could not reach DexScreener to verify this token. Nothing was charged. Try again in a moment.",
    };
  }

  // Only successes and definitive "not found" are worth caching; a transient
  // outage should not be remembered.
  if (result.ok || result.kind === "not_found") {
    cache().set(key, { at: Date.now(), result });
  }
  return result;
}

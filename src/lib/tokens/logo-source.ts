import { PublicKey } from "@solana/web3.js";
import { solanaRpcUrls } from "../payments/config";
import { fetchGuarded, fetchImage, type ImageResult } from "./image-fetch";
import { resolveToken } from "./dexscreener";

/**
 * Where a token's logo comes from, in the order the owner set.
 *
 * THREE SOURCES, BECAUSE ONE WAS NOT ENOUGH AND THAT WAS MEASURED. Until this
 * module existed the only source was DexScreener's `info.imageUrl`, which
 * exists only for enhanced profiles — and in this project's own production
 * database GIGA, POPCAT, MOG and BONK all carried `logo_url = NULL`. Four of
 * the five real tokens had no logo, so a feature built on that column mostly
 * did not appear.
 *
 *   1. METAPLEX, ON CHAIN. The token's own metadata account, which the mint
 *      authority wrote and nobody else can. It is the only source that is not
 *      somebody's index of the chain, so it goes first: when it disagrees
 *      with an aggregator, it is the aggregator that is stale.
 *   2. JUPITER. The list every Solana wallet already reads. Broad, and its
 *      icons live wherever the project put them.
 *   3. DEXSCREENER. Already here, already tested, and the one that carries a
 *      logo for tokens whose team paid to enhance a listing.
 *
 * EVERY URL ANY OF THEM RETURNS IS UNTRUSTED, including Metaplex's — the
 * on-chain document is written by the token's deployer, which is precisely
 * the party a hostile token would be. Nothing here fetches anything itself:
 * the string goes to `image-fetch.ts`, which owns every bound.
 */

/** The Token Metadata program. Its metadata PDA is where a mint's `uri` lives. */
const METADATA_PROGRAM = new PublicKey("metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s");

/** How long any one upstream gets before we move to the next. */
const SOURCE_TIMEOUT_MS = 4_000;

/** The most we will read of an off-chain metadata document. It is a small JSON object. */
const MAX_METADATA_BYTES = 128 * 1024;

export type LogoSource = "metaplex" | "jupiter" | "dexscreener";

export type LogoLookup =
  | { ok: true; source: LogoSource; image: ImageResult & { ok: true } }
  | { ok: false; reason: "no_logo" };

/**
 * Finds and fetches a token's logo, or reports that it has none.
 *
 * THE MINT IS THE ONLY INPUT. Nothing in this pipeline accepts a URL from a
 * caller: a request names a token, and every URL involved is one WE derived
 * from the chain or from a named upstream. That is what keeps the proxy from
 * being an open redirect with a cache in front of it.
 *
 * The sources are tried in order and the first one that yields bytes wins. A
 * source that yields a URL the proxy refuses does not stop the search — a
 * token whose Metaplex image is an SVG on an unknown host should still get
 * its Jupiter icon rather than nothing.
 */
export async function fetchTokenLogo(mint: string): Promise<LogoLookup> {
  for (const [source, find] of [
    ["metaplex", metaplexImage],
    ["jupiter", jupiterImage],
    ["dexscreener", dexscreenerImage],
  ] as const) {
    let candidate: string | null = null;
    try {
      candidate = await find(mint);
    } catch {
      // A source that throws is a source that is down. Try the next one.
      candidate = null;
    }
    if (!candidate) continue;

    const image = await fetchImage(candidate);
    if (image.ok) return { ok: true, source, image };
    // Refused — wrong host, wrong bytes, too big. The next source may do
    // better, and "this token has no logo we will serve" is only true once
    // all three have been asked.
  }

  return { ok: false, reason: "no_logo" };
}

/**
 * The `image` field of the token's own on-chain metadata document.
 *
 * Two hops, because that is how Token Metadata works: the account holds a
 * `uri`, and the document at that URI holds the image. Both are attacker
 * controlled and both are bounded — the URI through `resolveImageUrl`'s host
 * allowlist, the document by size and by being parsed into one known field.
 */
async function metaplexImage(mint: string): Promise<string | null> {
  let mintKey: PublicKey;
  try {
    mintKey = new PublicKey(mint);
  } catch {
    return null;
  }

  const [pda] = PublicKey.findProgramAddressSync(
    [Buffer.from("metadata"), METADATA_PROGRAM.toBuffer(), mintKey.toBuffer()],
    METADATA_PROGRAM,
  );

  const account = await rpcAccountData(pda.toBase58());
  if (!account) return null;

  const uri = readMetadataUri(account);
  if (!uri) return null;

  // THE SAME GUARDED PATH THE IMAGE USES, not a second one. This document is
  // on a third party's host and is exactly as attacker-controlled as the
  // image it names, so it gets the same host allowlist, the same address
  // pinning, the same byte cap and the same redirect discipline. It had its
  // own plain `fetch` at first, which was both weaker and broken — arweave
  // answers with a 302 and that fetch refused redirects, so every Metaplex
  // lookup failed silently and fell through to Jupiter.
  const document = await fetchGuarded(uri, MAX_METADATA_BYTES);
  if (!document.ok) return null;

  const image = readImageField(document.bytes);
  return image;
}

/**
 * The one field we want out of a metadata document, and nothing else.
 *
 * The document is attacker-controlled; parsing it into a single known string
 * here means nothing unexpected can reach the fetch below it. A non-string
 * `image` becomes null rather than being coerced — `image: {}` turning into
 * "[object Object]" is the small version of the same mistake.
 */
export function readImageField(bytes: Buffer): string | null {
  try {
    const parsed: unknown = JSON.parse(bytes.toString("utf8"));
    if (typeof parsed !== "object" || parsed === null) return null;
    const image = (parsed as { image?: unknown }).image;
    if (typeof image !== "string") return null;
    const trimmed = image.trim();
    return trimmed.length > 0 ? trimmed : null;
  } catch {
    return null;
  }
}

/**
 * Pulls `uri` out of a Token Metadata account.
 *
 * The layout is fixed and this reads it by offset rather than pulling in a
 * borsh decoder for three fields: key(1) + update_authority(32) + mint(32),
 * then three borsh strings — name, symbol, uri — each a 4-byte little-endian
 * length followed by that many bytes. The strings are null-padded to their
 * declared maximum, so the padding is trimmed rather than trusted.
 *
 * Every read is bounds-checked. This buffer is an account whose contents the
 * token's own deployer controls, and a length prefix that says 4 billion is
 * the obvious thing to write in it.
 */
export function readMetadataUri(data: Buffer): string | null {
  let offset = 1 + 32 + 32;
  for (let field = 0; field < 3; field++) {
    if (offset + 4 > data.length) return null;
    const length = data.readUInt32LE(offset);
    offset += 4;
    // A declared length past the end of the account is a malformed account,
    // not a long string.
    if (length > data.length - offset) return null;
    if (field === 2) {
      return data.subarray(offset, offset + length).toString("utf8").replace(/\0+$/, "").trim();
    }
    offset += length;
  }
  return null;
}

/** `getAccountInfo`, base64, across the configured endpoints in order. */
async function rpcAccountData(address: string): Promise<Buffer | null> {
  for (const endpoint of solanaRpcUrls()) {
    try {
      const response = await fetch(endpoint, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "getAccountInfo",
          params: [address, { encoding: "base64" }],
        }),
        signal: AbortSignal.timeout(SOURCE_TIMEOUT_MS),
      });
      if (!response.ok) continue;
      const body = (await response.json()) as {
        result?: { value?: { data?: [string, string] | null } | null };
      };
      const encoded = body.result?.value?.data?.[0];
      if (typeof encoded !== "string") return null;
      return Buffer.from(encoded, "base64");
    } catch {
      // Next endpoint. The RPC URL is ours, but its availability is not.
    }
  }
  return null;
}

/**
 * Jupiter's token record, which every Solana wallet already reads.
 *
 * Its `icon` is whatever the project put in its own metadata, so it lands on
 * arweave, on IPFS gateways and on raw.githubusercontent.com — an open-ended
 * set, which is the whole reason the proxy has a host allowlist rather than
 * this function having one.
 */
async function jupiterImage(mint: string): Promise<string | null> {
  const response = await fetch(
    `https://lite-api.jup.ag/tokens/v2/search?query=${encodeURIComponent(mint)}`,
    { headers: { accept: "application/json" }, signal: AbortSignal.timeout(SOURCE_TIMEOUT_MS) },
  );
  if (!response.ok) return null;

  const body = (await response.json()) as unknown;
  const rows = Array.isArray(body) ? body : [];
  // The search is a search: it can return near matches, and a near match is a
  // different token's logo on this token's row. Only an exact mint counts.
  const hit = rows.find(
    (row): row is { id?: string; icon?: string } =>
      typeof row === "object" && row !== null && (row as { id?: string }).id === mint,
  );
  const icon = typeof hit?.icon === "string" ? hit.icon.trim() : "";
  return icon.length > 0 ? icon : null;
}

/** The source that was already here, kept as the last resort rather than the only one. */
async function dexscreenerImage(mint: string): Promise<string | null> {
  // `resolveToken` already caches, already restricts its image host to
  // DexScreener's own CDN, and is already tested. Reusing it is why this
  // source costs three lines.
  const result = await resolveToken("solana", mint);
  return result.ok ? (result.metadata.logoUrl ?? null) : null;
}

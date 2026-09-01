import { lookup } from "node:dns/promises";
import { request } from "node:https";
import { BlockList, isIPv4, isIPv6 } from "node:net";

/**
 * Fetching an image from a host somebody else chose, under bounds.
 *
 * **This is the only place in pixelwar that fetches a URL we did not write**,
 * and every rule below is for that. A token's logo URL comes from
 * DexScreener, Jupiter or a Metaplex metadata document — three third parties,
 * two of which will happily echo a string the token's own deployer supplied.
 * So the URL is attacker-controlled as a matter of course, not "if something
 * goes wrong".
 *
 * WHY THE PROXY EXISTS AT ALL, which is a privacy question before it is a
 * security one. `dexscreener.ts` already refuses any image host but
 * DexScreener's CDN, and says why: "an image we serve to every visitor from a
 * domain a third party controls — a tracking beacon on our audience." That
 * rule is right, and it is the reason most tokens have no logo: Jupiter's
 * icons live on arweave, on IPFS gateways and on raw.githubusercontent.com,
 * an open-ended set. Proxying is how this repository already solved the same
 * shape of problem for RPC — `/api/rpc` exists so nothing of the upstream
 * reaches the browser — and it is the only way to widen the sources without
 * widening what our visitors are exposed to.
 *
 * THE THREAT IS SSRF. This code runs on a server that can reach things a
 * visitor cannot: a cloud metadata endpoint on 169.254.169.254, a database on
 * a private subnet, a neighbour on localhost. A fetch of somebody else's URL
 * is a request they get to make FROM INSIDE. So the question is never "is
 * this URL bad" — it is "is this URL one of the small set of shapes we
 * accept", and everything else is refused.
 *
 * WHAT THIS CLOSES THAT ITS ANCESTOR LEFT OPEN. This is modelled on
 * nftraffle's `metadata-fetch.ts`, which states its own residual risk out
 * loud: "What this does NOT stop, said out loud: DNS rebinding... Closing it
 * needs resolution and connection to be the same step — a custom agent that
 * pins the resolved address — which Node's fetch does not expose." That gap
 * is closed here. This module resolves the hostname itself, checks every
 * address it gets back, and then connects to the ADDRESS with `servername`
 * and a `Host` header — so the name that was validated and the address that
 * is dialled cannot differ. It uses `node:https` rather than `fetch` for
 * exactly that reason, and adds no dependency to get it.
 */

/** How long a logo host gets, per hop. A missing logo is a flag, which is fine. */
const TIMEOUT_MS = 4_000;

/**
 * How many redirects will be followed.
 *
 * REDIRECTS ARE FOLLOWED, AND THAT IS A MEASURED DECISION RATHER THAN A
 * CONVENIENCE. Refusing them outright is safer to write and was written
 * first — and then measured: `arweave.net` answers with a 302 to
 * `<hash>.arweave.net`, and `nftstorage.link` with a 302 to
 * `<cid>.ipfs.dweb.link`. Content-addressed storage works this way, so a
 * no-redirect policy silently refuses most Solana logos and looks exactly
 * like "tokens do not have logos".
 *
 * WHAT MAKES FOLLOWING SAFE IS THE SHAPE OF THE LOOP, not the count. The
 * danger in "validate, follow, re-validate" is an off-by-one where the first
 * URL is checked by one path and the hops by another. So there is no first
 * URL here: `fetchImage` runs the same body every iteration — resolve the
 * scheme and host, resolve DNS, check EVERY address, dial that address — and
 * a `Location` simply replaces the URL and goes round again. A hop that
 * leaves the allowlist, or lands on a private address, is refused with the
 * same code that would have refused it as the original.
 *
 * Three is what content-addressed storage actually needs; a chain longer than
 * that is a loop or a redirector, and neither is a logo.
 */
const MAX_REDIRECTS = 3;

/**
 * The most we will read.
 *
 * **Enforced while reading, never from `content-length`.** A host can omit
 * that header or lie in it, so the declared size is only a fast rejection and
 * the stream itself is capped as it arrives. A check a peer can turn off is
 * not a check.
 */
export const MAX_IMAGE_BYTES = 512 * 1024;

/**
 * Hosts we are willing to fetch an image from.
 *
 * AN ALLOWLIST, AND THE CONSEQUENCE IS DELIBERATE: a token whose logo lives
 * anywhere else gets no logo, and the scoreboard shows its flag colour, which
 * is what it shows today. That is the correct trade. The alternative — accept
 * any host our upstreams name — puts an arbitrary third party in the request
 * path of every visitor, which is the exact thing the proxy was built to
 * prevent, arriving through the back door.
 *
 * The entries are the hosts our three sources actually use, measured rather
 * than guessed: Jupiter's icons for BONK and POPCAT are on arweave, SOL's is
 * on raw.githubusercontent.com, WIF's is on an nftstorage IPFS gateway, and
 * DexScreener's are on its own CDN.
 */
const ALLOWED_HOSTS = new Set([
  "cdn.dexscreener.com",
  "arweave.net",
  "ipfs.io",
  "raw.githubusercontent.com",
  "nftstorage.link",
]);

/**
 * Suffixes accepted in addition to the exact hosts above.
 *
 * IPFS gateways address content by putting the CID in the SUBDOMAIN, which is
 * what makes each response same-origin-isolated on their end. There is no way
 * to name those hosts exactly, so the suffix is the unit. A leading dot is
 * required in the comparison so `evil-nftstorage.link` cannot match
 * `nftstorage.link`.
 */
const ALLOWED_HOST_SUFFIXES = [
  ".ipfs.nftstorage.link",
  ".ipfs.dweb.link",
  // Arweave answers `arweave.net/<tx>` with a 302 to
  // `<hash>.arweave.net/<tx>`, which is the same content-addressing idea.
  // Measured, not assumed: two of the four sources this pipeline uses were
  // refused as `redirected` until this line existed.
  ".arweave.net",
];

/** Where an `ipfs://` reference is resolved. Content-addressed, so a gateway cannot substitute bytes. */
const IPFS_GATEWAY = "https://ipfs.io/ipfs/";

/**
 * Address ranges that are never a legitimate image host.
 *
 * `net.BlockList` rather than a hand-rolled comparison: it is standard
 * library, it understands both families, and a subnet written as a subnet is
 * a great deal harder to get subtly wrong than a chain of octet comparisons.
 */
function forbidden(): BlockList {
  const list = new BlockList();
  // IPv4.
  list.addSubnet("0.0.0.0", 8, "ipv4"); // "this network"
  list.addSubnet("10.0.0.0", 8, "ipv4"); // private
  list.addSubnet("100.64.0.0", 10, "ipv4"); // carrier-grade NAT
  list.addSubnet("127.0.0.0", 8, "ipv4"); // loopback
  list.addSubnet("169.254.0.0", 16, "ipv4"); // link-local: cloud metadata lives here
  list.addSubnet("172.16.0.0", 12, "ipv4"); // private
  list.addSubnet("192.0.0.0", 24, "ipv4"); // IETF protocol assignments
  list.addSubnet("192.0.2.0", 24, "ipv4"); // TEST-NET-1
  list.addSubnet("192.168.0.0", 16, "ipv4"); // private
  list.addSubnet("198.18.0.0", 15, "ipv4"); // benchmarking
  list.addSubnet("198.51.100.0", 24, "ipv4"); // TEST-NET-2
  list.addSubnet("203.0.113.0", 24, "ipv4"); // TEST-NET-3
  list.addSubnet("224.0.0.0", 4, "ipv4"); // multicast
  list.addSubnet("240.0.0.0", 4, "ipv4"); // reserved, includes broadcast
  // IPv6.
  list.addAddress("::", "ipv6"); // unspecified
  list.addAddress("::1", "ipv6"); // loopback
  list.addSubnet("fc00::", 7, "ipv6"); // unique local
  list.addSubnet("fe80::", 10, "ipv6"); // link-local
  list.addSubnet("ff00::", 8, "ipv6"); // multicast
  list.addSubnet("2001:db8::", 32, "ipv6"); // documentation
  list.addSubnet("64:ff9b::", 96, "ipv6"); // NAT64
  return list;
}

const BLOCKED = forbidden();

/**
 * Whether one resolved address may be dialled.
 *
 * V4-MAPPED V6 IS UNWRAPPED AND CHECKED AS V4, and this is the case that
 * would otherwise walk straight through: `::ffff:127.0.0.1` is a perfectly
 * ordinary IPv6 address that no IPv6 rule above matches, and it reaches
 * loopback. Checking the wrapper without unwrapping it is how a blocklist
 * looks complete and is not.
 */
export function addressAllowed(address: string): boolean {
  if (isIPv4(address)) return !BLOCKED.check(address, "ipv4");
  if (!isIPv6(address)) return false;

  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(address);
  if (mapped) return isIPv4(mapped[1]) && !BLOCKED.check(mapped[1], "ipv4");
  // The other spelling of the same thing: ::ffff:7f00:1.
  const hexMapped = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i.exec(address);
  if (hexMapped) {
    const [hi, lo] = [Number.parseInt(hexMapped[1], 16), Number.parseInt(hexMapped[2], 16)];
    const dotted = `${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`;
    return !BLOCKED.check(dotted, "ipv4");
  }

  return !BLOCKED.check(address, "ipv6");
}

export type ImageRefusal =
  | "bad_url"
  | "scheme_not_allowed"
  | "host_not_allowed"
  | "private_address"
  | "unresolvable"
  | "redirected"
  | "too_large"
  | "timeout"
  | "unreachable"
  | "not_an_image";

export type ImageResult =
  | { ok: true; bytes: Buffer; contentType: string }
  | { ok: false; reason: ImageRefusal };

export type BytesResult =
  | { ok: true; bytes: Buffer }
  | { ok: false; reason: ImageRefusal };

/**
 * Turns a raw image reference into a URL this module is willing to dial, or
 * says why not.
 *
 * Exported because it is most of the decision and deserves to be tested
 * without a network.
 */
export function resolveImageUrl(
  raw: string,
): { ok: true; url: URL } | { ok: false; reason: ImageRefusal } {
  const trimmed = raw.trim();
  if (trimmed.length === 0 || trimmed.length > 2_048) return { ok: false, reason: "bad_url" };

  let candidate = trimmed;
  if (candidate.toLowerCase().startsWith("ipfs://")) {
    const path = candidate.slice("ipfs://".length).replace(/^ipfs\//i, "");
    if (!/^[A-Za-z0-9][A-Za-z0-9./_-]*$/.test(path)) return { ok: false, reason: "bad_url" };
    candidate = IPFS_GATEWAY + path;
  }

  let url: URL;
  try {
    url = new URL(candidate);
  } catch {
    return { ok: false, reason: "bad_url" };
  }

  // `http:` is refused rather than upgraded. Plaintext means any party on the
  // path chooses the bytes we serve, and most interesting SSRF targets speak
  // it — refusing the scheme removes the whole class before the host matters.
  if (url.protocol !== "https:") return { ok: false, reason: "scheme_not_allowed" };
  // Credentials would be sent to the host on our behalf and are never
  // legitimate in a logo URL.
  if (url.username || url.password) return { ok: false, reason: "bad_url" };
  // A non-default port is a strong signal of something other than a CDN, and
  // no allowed host serves images anywhere but 443.
  if (url.port && url.port !== "443") return { ok: false, reason: "host_not_allowed" };
  if (!hostAllowed(url.hostname)) return { ok: false, reason: "host_not_allowed" };

  return { ok: true, url };
}

function hostAllowed(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/\.$/, "");
  if (ALLOWED_HOSTS.has(host)) return true;
  return ALLOWED_HOST_SUFFIXES.some((suffix) => host.endsWith(suffix));
}

/**
 * The magic bytes of the formats we serve, and nothing else.
 *
 * THE TYPE IS DECIDED BY THE BYTES, NEVER BY THE HEADER, and the output
 * `Content-Type` is this value rather than whatever the upstream said.
 * Sniffing and then forwarding somebody else's header would be measuring one
 * thing and publishing another — the check would be real and useless.
 *
 * SVG IS DELIBERATELY ABSENT. It is markup, it can carry script and remote
 * references, and "should we render untrusted SVG" is a question about our
 * own pages that deserves its own round rather than arriving as a side
 * effect of a logo pipeline. A token whose only logo is an SVG gets its flag.
 */
export function sniffImageType(bytes: Buffer): string | null {
  if (bytes.length < 12) return null;
  if (bytes[0] === 0x89 && bytes.subarray(1, 4).toString("latin1") === "PNG") return "image/png";
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  const head = bytes.subarray(0, 6).toString("latin1");
  if (head === "GIF87a" || head === "GIF89a") return "image/gif";
  if (
    bytes.subarray(0, 4).toString("latin1") === "RIFF" &&
    bytes.subarray(8, 12).toString("latin1") === "WEBP"
  ) {
    return "image/webp";
  }
  return null;
}

/**
 * Fetches one image, under every bound above. Never throws.
 *
 * The type is decided by the bytes; see `sniffImageType`.
 */
export async function fetchImage(rawUrl: string): Promise<ImageResult> {
  const result = await fetchGuarded(rawUrl, MAX_IMAGE_BYTES);
  if (!result.ok) return result;
  const contentType = sniffImageType(result.bytes);
  if (!contentType) return { ok: false, reason: "not_an_image" };
  return { ok: true, bytes: result.bytes, contentType };
}

/**
 * Fetches bytes from a URL somebody else chose, under every bound above.
 *
 * ONE GUARDED PATH, AND THIS IS WHY IT IS SHARED RATHER THAN COPIED. A
 * token's logo takes TWO hops through hostile territory, not one: the
 * Metaplex metadata account names a JSON document on somebody's host, and
 * that document names the image. The first version of this pipeline fetched
 * the document with a plain `fetch` — no address pinning, no allowlist at
 * connect time, a second weaker path doing the same job as the strong one.
 *
 * It also did not work, which is how it was found: that fetch used
 * `redirect: "error"`, arweave answers with a 302, and every Metaplex lookup
 * failed silently and fell through to Jupiter. The source the owner put FIRST
 * — the only one written by the mint authority rather than by an index —
 * never once fired. A second path is not just a second thing to secure; it is
 * a second thing to keep working.
 *
 * ONE LOOP, ONE SET OF CHECKS. Every iteration re-derives everything from the
 * URL it is about to dial: scheme, host, addresses. The original URL and a
 * redirect target go through identical code, so there is no path a `Location`
 * can take that the first URL could not — which is the off-by-one that makes
 * "validate, follow, re-validate" dangerous when it is written as two
 * separate pieces of code.
 */
export async function fetchGuarded(rawUrl: string, maxBytes: number): Promise<BytesResult> {
  let next = rawUrl;

  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const resolved = resolveImageUrl(next);
    if (!resolved.ok) return resolved;
    const { url } = resolved;

    // RESOLUTION AND CONNECTION ARE THE SAME STEP. The addresses are checked
    // here and one of them is dialled directly below, so the name that was
    // validated and the address that is reached cannot differ — which is the
    // DNS-rebinding hole a name-only check leaves open, and which this
    // module's ancestor documents as accepted.
    let addresses: Array<{ address: string; family: number }>;
    try {
      addresses = await lookup(url.hostname, { all: true, verbatim: true });
    } catch {
      return { ok: false, reason: "unresolvable" };
    }
    if (addresses.length === 0) return { ok: false, reason: "unresolvable" };

    // EVERY address, not merely the one we intend to use. A host that
    // resolves to one public and one private address is not a host with an
    // unlucky record; it is the shape of a rebinding attempt, and picking the
    // public one would be trusting a race.
    if (!addresses.every((entry) => addressAllowed(entry.address))) {
      return { ok: false, reason: "private_address" };
    }

    const hopResult = await dial(url, addresses[0], maxBytes);
    if (hopResult.kind === "body") return hopResult.result;
    // A relative Location is legal and common; resolving it against the URL
    // we actually dialled is the only correct base.
    next = new URL(hopResult.location, url).toString();
  }

  return { ok: false, reason: "redirected" };
}

type Hop =
  | { kind: "body"; result: BytesResult }
  | { kind: "redirect"; location: string };

/** One request to one validated address. Never throws. */
function dial(
  url: URL,
  target: { address: string; family: number },
  maxBytes: number,
): Promise<Hop> {
  return new Promise<Hop>((resolveResult) => {
    let settled = false;
    const finish = (hop: Hop) => {
      if (settled) return;
      settled = true;
      resolveResult(hop);
    };
    const refuse = (reason: ImageRefusal) => finish({ kind: "body", result: { ok: false, reason } });

    const req = request(
      {
        host: target.address,
        family: target.family,
        port: 443,
        path: `${url.pathname}${url.search}`,
        method: "GET",
        // The name travels as SNI and as the Host header, so TLS is still
        // verified against the hostname we validated rather than against the
        // address we dialled. Without `servername` this would fail every
        // certificate check, which is the good failure — but it would also
        // tempt somebody to disable verification, which is the bad fix.
        servername: url.hostname,
          // `*/*`: this path carries both images and metadata documents.
        headers: { host: url.hostname, accept: "*/*", "user-agent": "pixelwar.fun" },
        timeout: TIMEOUT_MS,
      },
      (res) => {
        const status = res.statusCode ?? 0;
        const location = res.headers.location;

        if (status >= 300 && status < 400) {
          res.destroy();
          // A 3xx with no Location is not a redirect, it is a broken host.
          if (typeof location !== "string" || location.length === 0) return refuse("unreachable");
          return finish({ kind: "redirect", location });
        }
        if (status !== 200) {
          res.destroy();
          return refuse("unreachable");
        }

        const declared = Number(res.headers["content-length"]);
        if (Number.isFinite(declared) && declared > maxBytes) {
          res.destroy();
          return refuse("too_large");
        }

        const chunks: Buffer[] = [];
        let total = 0;
        res.on("data", (chunk: Buffer) => {
          total += chunk.length;
          // Capped AS IT ARRIVES. The declared length above is a courtesy; a
          // host that lies about it hits this instead, having wasted exactly
          // one chunk past the cap.
          if (total > maxBytes) {
            res.destroy();
            return refuse("too_large");
          }
          chunks.push(chunk);
        });
        res.on("end", () => {
          finish({ kind: "body", result: { ok: true, bytes: Buffer.concat(chunks) } });
        });
        res.on("error", () => refuse("unreachable"));
      },
    );

    req.on("timeout", () => {
      req.destroy();
      refuse("timeout");
    });
    // THE REASON, NEVER THE ERROR. A failed request carries the target in its
    // message, and that target was supplied by a third party.
    req.on("error", () => refuse("unreachable"));
    req.end();
  });
}

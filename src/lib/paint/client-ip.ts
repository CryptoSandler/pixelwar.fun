import { createHash } from "node:crypto";
import { allowUntrustedClientIp, rateLimitSalt, trustedProxyHops } from "../config";

/** Raw IPs are never stored. This is only ever used as a counting key. */
export function hashIp(ip: string): string {
  return createHash("sha256").update(`${rateLimitSalt()}:${normaliseIp(ip)}`).digest("hex");
}

/**
 * One canonical spelling for one address.
 *
 * A dual-stack listener reports IPv4 clients as `::ffff:a.b.c.d`. Both
 * `hashIp` and `subnetKey` must agree about who that is — two spellings for
 * the same visitor means two buckets, and for `hashIp` that means the
 * cooldown quietly halves itself.
 */
export function normaliseIp(ip: string): string {
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(ip.trim());
  return mapped ? mapped[1] : ip.trim().toLowerCase();
}

/**
 * Headers a platform sets itself and a caller cannot forge, because the edge
 * overwrites them. Checked before x-forwarded-for, which is append-only and
 * therefore partly caller-controlled.
 */
const PLATFORM_IP_HEADERS = [
  "cf-connecting-ip",
  "true-client-ip",
  "x-vercel-forwarded-for",
  "fly-client-ip",
] as const;

export type ClientIdentity =
  | { ok: true; ip: string; source: string }
  | { ok: false; reason: string };

/**
 * Caller identity, read from the right of x-forwarded-for rather than the left.
 *
 * Proxies APPEND to that header, so the left-most entry is whatever the caller
 * sent — reading it let anyone pick their own rate-limit bucket with a forged
 * header. The trustworthy entry is the one our own proxy appended, counted from
 * the right by how many hops sit in front of us.
 *
 * Fails closed. If no header can be trusted we return an error rather than a
 * shared bucket: a shared bucket for every anonymous caller is either an
 * unlimited allowance or a self-inflicted outage, and neither is a limit.
 */
export function clientIp(request: Request): ClientIdentity {
  for (const header of PLATFORM_IP_HEADERS) {
    const value = request.headers.get(header)?.split(",")[0]?.trim();
    if (value) return { ok: true, ip: value, source: header };
  }

  const forwarded = request.headers.get("x-forwarded-for");
  if (forwarded) {
    const hops = trustedProxyHops();
    const entries = forwarded
      .split(",")
      .map((part) => part.trim())
      .filter(Boolean);

    // With one proxy in front, entries[len-1] is what that proxy appended: the
    // address it actually saw. Anything further left the caller could have
    // written. Too few entries means the header did not come through our proxy.
    const index = entries.length - hops;
    if (index >= 0 && entries[index]) {
      return { ok: true, ip: entries[index], source: `x-forwarded-for[-${hops}]` };
    }
    return {
      ok: false,
      reason: `x-forwarded-for has ${entries.length} entries but ${hops} trusted proxies are configured.`,
    };
  }

  if (allowUntrustedClientIp()) {
    return { ok: true, ip: "untrusted-local", source: "development" };
  }

  return {
    ok: false,
    reason:
      "No trusted client address. Set TRUSTED_PROXY_HOPS to match the deployment, or ALLOW_UNTRUSTED_CLIENT_IP=true for local development.",
  };
}

/**
 * The address's network prefix, hashed.
 *
 * A phone cycling through a carrier's pool gets a fresh address on every
 * reconnect but not a fresh prefix, so the prefix is where rotation actually
 * shows up. /24 for IPv4 and /64 for IPv6 are the smallest blocks routinely
 * allocated to one subscriber; going narrower would start grouping strangers
 * together, which turns a burst cap into an outage for a neighbourhood.
 */
export function subnetKey(ip: string): string {
  return createHash("sha256")
    .update(`${rateLimitSalt()}:subnet:${prefixOf(normaliseIp(ip))}`)
    .digest("hex");
}

function prefixOf(ip: string): string {
  if (ip.includes(":")) return `${expandIpv6(ip).slice(0, 4).join(":")}::/64`;

  const octets = ip.split(".");
  if (octets.length !== 4) return ip; // not an address we recognise; group it alone
  return `${octets.slice(0, 3).join(".")}.0/24`;
}

/**
 * A known limit, recorded rather than fixed: clients behind one NAT64 gateway
 * share a bucket.
 *
 * An IPv6 address with an embedded IPv4 tail — `64:ff9b::1.2.3.4` — carries
 * that IPv4 in its last 32 bits, which are inside the /64. So every client
 * behind one NAT64 prefix groups together no matter how the address is
 * expanded, and no rewriting of the tail can change that.
 *
 * This is left alone deliberately, because it is the same trade the IPv4 side
 * already makes: a /24 lumps a CGNAT pool together too. `::ffff:a.b.c.d` is
 * the case that IS handled, in `normaliseIp` — not by adjusting the prefix,
 * but by recognising that such an address is simply an IPv4 client wearing an
 * IPv6 spelling, and sending it down the /24 path.
 */

/** Eight lowercase, unpadded groups. "2001:db8::1" and "2001:0db8:0:0::1" agree. */
function expandIpv6(ip: string): string[] {
  const [head, tail = ""] = ip.toLowerCase().split("::");
  const left = head ? head.split(":") : [];
  const right = tail ? tail.split(":") : [];
  const missing = 8 - left.length - right.length;
  const middle = ip.includes("::") ? Array(Math.max(0, missing)).fill("0") : [];
  return [...left, ...middle, ...right].map((group) =>
    Number.parseInt(group || "0", 16).toString(16),
  );
}

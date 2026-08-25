/**
 * Link hygiene. Three jobs, in this order:
 *   1. Reject anything whose destination can change after we approve it.
 *   2. Strip everything that lets one destination wear many different URLs.
 *   3. Produce a stable canonical string we can compare and store.
 */

/** Redirectors: the destination is mutable after review, so we never store one. */
const SHORTENERS = new Set([
  "bit.ly", "t.co", "tinyurl.com", "goo.gl", "ow.ly", "buff.ly", "is.gd",
  "cutt.ly", "rebrand.ly", "shorturl.at", "rb.gy", "t.ly", "s.id", "lnkd.in",
  "trib.al", "dlvr.it", "shorte.st", "adf.ly", "bl.ink", "short.io", "tiny.cc",
  "v.gd", "clck.ru", "qr.ae", "soo.gd", "u.to", "linktr.ee", "lnk.bio",
  "beacons.ai", "linkin.bio", "solo.to", "bio.link",
]);

/** Messaging and invite links: the content behind them is not auditable. */
const CHAT_HOSTS = new Set([
  "t.me", "telegram.me", "telegram.dog", "discord.gg", "discord.com",
  "discordapp.com", "chat.whatsapp.com", "wa.me", "whatsapp.com",
  "signal.group", "signal.me", "m.me", "messenger.com", "join.skype.com",
]);

export type LinkKind = "launchpad" | "website" | "x" | "telegram" | "discord";

export type LinkCheck =
  | { ok: true; url: string; host: string; strippedParams: string[] }
  | { ok: false; reason: string };

function registrableHost(hostname: string): string {
  return hostname.toLowerCase().replace(/^www\./, "");
}

/** True when `host` is `base` or a subdomain of it. */
export function hostMatches(host: string, base: string): boolean {
  return host === base || host.endsWith(`.${base}`);
}

export function normalizeLink(input: string, kind: LinkKind): LinkCheck {
  const raw = input.trim();
  if (!raw) return { ok: false, reason: "This link is required." };

  let url: URL;
  try {
    url = new URL(/^https?:\/\//i.test(raw) ? raw : `https://${raw}`);
  } catch {
    return { ok: false, reason: "That is not a valid URL." };
  }

  if (url.protocol !== "https:") {
    return {
      ok: false,
      reason: "Only https links are accepted.",
    };
  }

  const host = registrableHost(url.hostname);
  if (!host.includes(".")) {
    return { ok: false, reason: "That URL has no valid domain." };
  }

  if (SHORTENERS.has(host)) {
    return {
      ok: false,
      reason:
        "Link shorteners and link-in-bio pages are not accepted. They can be repointed after review, so paste the destination itself.",
    };
  }

  // Chat invites are blocked as a launchpad or website, but Telegram and Discord
  // are legitimate social links, so only block them where they do not belong.
  const socialSlotForHost =
    (kind === "telegram" && hostMatches(host, "t.me")) ||
    (kind === "discord" && (hostMatches(host, "discord.gg") || hostMatches(host, "discord.com")));

  if (CHAT_HOSTS.has(host) && !socialSlotForHost) {
    return {
      ok: false,
      reason: "Chat and invite links do not belong in this field.",
    };
  }

  // Every query parameter goes. Referral and affiliate tags ride in on query
  // strings, and two URLs that differ only by a param are the same destination —
  // keeping them would hand everyone a trivial way around de-duplication.
  const strippedParams = [...url.searchParams.keys()];
  url.search = "";
  url.hash = "";
  url.hostname = host;

  // Trailing slashes are noise for comparison purposes.
  if (url.pathname !== "/" && url.pathname.endsWith("/")) {
    url.pathname = url.pathname.replace(/\/+$/, "");
  }

  return { ok: true, url: url.toString(), host, strippedParams };
}

/** Accepts a full X URL or a bare @handle and returns a canonical profile URL. */
export function normalizeXHandle(input: string): LinkCheck {
  const raw = input.trim();
  if (!raw) return { ok: false, reason: "This link is required." };

  const bare = raw.replace(/^@/, "");
  if (/^[A-Za-z0-9_]{1,15}$/.test(bare) && !raw.includes("/") && !raw.includes(".")) {
    return { ok: true, url: `https://x.com/${bare}`, host: "x.com", strippedParams: [] };
  }

  const checked = normalizeLink(raw, "x");
  if (!checked.ok) return checked;

  if (!hostMatches(checked.host, "x.com") && !hostMatches(checked.host, "twitter.com")) {
    return { ok: false, reason: "This must be an X profile or an @handle." };
  }

  const handle = new URL(checked.url).pathname.split("/").filter(Boolean)[0];
  if (!handle || !/^[A-Za-z0-9_]{1,15}$/.test(handle)) {
    return { ok: false, reason: "That X profile does not look valid." };
  }

  return { ok: true, url: `https://x.com/${handle}`, host: "x.com", strippedParams: checked.strippedParams };
}

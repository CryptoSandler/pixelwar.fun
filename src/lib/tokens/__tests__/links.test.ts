import { describe, expect, it } from "vitest";
import { normalizeLink, normalizeXHandle } from "../links";

describe("query params", () => {
  it("strips tracking params from a website link", () => {
    const result = normalizeLink("https://bonkcoin.com/coin/abc?utm_source=x&ref=someguy", "website");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.url).toBe("https://bonkcoin.com/coin/abc");
    expect(result.strippedParams).toEqual(["utm_source", "ref"]);
  });

  it("collapses links that differ only by params into one canonical URL", () => {
    const a = normalizeLink("https://example.com/token/0xabc?ref=alice", "website");
    const b = normalizeLink("https://example.com/token/0xabc?ref=bob", "website");
    expect(a.ok && b.ok && a.url === b.url).toBe(true);
  });

  it("normalizes www, casing and trailing slashes", () => {
    const a = normalizeLink("https://WWW.Example.Com/coin/abc/", "website");
    const b = normalizeLink("example.com/coin/abc", "website");
    expect(a.ok && b.ok && a.url === b.url).toBe(true);
  });
});

describe("shorteners", () => {
  it.each(["bit.ly/abc", "https://t.co/xyz", "tinyurl.com/foo", "linktr.ee/proj"])(
    "rejects %s",
    (link) => {
      expect(normalizeLink(link, "website").ok).toBe(false);
    },
  );
});

describe("chat links", () => {
  it("rejects a telegram invite in the website field", () => {
    expect(normalizeLink("https://t.me/somegroup", "website").ok).toBe(false);
  });

  it("rejects a discord invite in the website field", () => {
    expect(normalizeLink("https://discord.gg/abc", "website").ok).toBe(false);
  });

  it("allows telegram in the telegram field", () => {
    expect(normalizeLink("https://t.me/somegroup", "telegram").ok).toBe(true);
  });
});

describe("x handles", () => {
  it("accepts a bare @handle", () => {
    const result = normalizeXHandle("@somebody");
    expect(result.ok && result.url).toBe("https://x.com/somebody");
  });

  it("maps twitter.com to x.com so both forms are one identity", () => {
    const a = normalizeXHandle("https://twitter.com/somebody");
    const b = normalizeXHandle("https://x.com/somebody?s=21");
    expect(a.ok && b.ok && a.url === b.url).toBe(true);
  });

  it("rejects a non-X profile", () => {
    expect(normalizeXHandle("https://facebook.com/somebody").ok).toBe(false);
  });
});

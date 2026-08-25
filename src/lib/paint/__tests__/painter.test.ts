import { beforeEach, describe, expect, it } from "vitest";
import { PAINTER_COOKIE, issuePainter, painterSetCookie, readPainter } from "../painter";

function withCookie(value: string): Request {
  return new Request("https://pixelwar.fun/api/paint", {
    headers: { cookie: `${PAINTER_COOKIE}=${value}` },
  });
}

describe("painter identity", () => {
  beforeEach(() => {
    process.env.PAINTER_COOKIE_SECRET = "secret-under-test";
    process.env.RATE_LIMIT_SALT = "test-salt";
  });

  it("issues a different identity each time", () => {
    expect(issuePainter().cookieValue).not.toBe(issuePainter().cookieValue);
  });

  it("reads back the key it issued", () => {
    const issued = issuePainter();
    expect(readPainter(withCookie(issued.cookieValue))).toBe(issued.painterKey);
  });

  it("rejects a cookie whose signature does not match", () => {
    const issued = issuePainter();
    const [id] = issued.cookieValue.split(".");
    expect(readPainter(withCookie(`${id}.forged-signature`))).toBeNull();
  });

  it("rejects a cookie signed with a different secret", () => {
    const issued = issuePainter();
    process.env.PAINTER_COOKIE_SECRET = "a-different-secret";
    expect(readPainter(withCookie(issued.cookieValue))).toBeNull();
  });

  it("rejects malformed cookies rather than trusting them", () => {
    // "%", "%zz", and "abc%" are malformed percent-escapes: decodeURIComponent
    // throws on them, and that throw must turn into a rejection, not a 500.
    for (const value of ["", "no-dot", ".", "a.b.c", "%", "%zz", "abc%"]) {
      expect(readPainter(withCookie(value))).toBeNull();
    }
  });

  it("returns null when there is no cookie at all", () => {
    expect(readPainter(new Request("https://pixelwar.fun/api/paint"))).toBeNull();
  });

  it("never stores anything that could reconstruct the cookie", () => {
    const issued = issuePainter();
    const [id] = issued.cookieValue.split(".");
    // The key is a salted hash of the id. Holding the key must not be enough
    // to mint a valid cookie, so a database leak is not a forgery kit.
    expect(issued.painterKey).not.toContain(id);
    expect(issued.cookieValue).not.toContain(issued.painterKey);
  });

  it("sets a cookie that a script cannot read and a cross-site request cannot send", () => {
    const header = painterSetCookie("value-under-test");
    expect(header).toContain("HttpOnly");
    expect(header).toContain("SameSite=Lax");
    expect(header).toContain("Secure");
    expect(header).toContain("Path=/");
  });
});

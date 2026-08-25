import { beforeEach, describe, expect, it } from "vitest";
import { clientIp, hashIp, subnetKey } from "../client-ip";

function request(headers: Record<string, string>): Request {
  return new Request("https://pixelwar.fun/api/paint", { headers });
}

describe("clientIp", () => {
  beforeEach(() => {
    process.env.TRUSTED_PROXY_HOPS = "1";
    delete process.env.ALLOW_UNTRUSTED_CLIENT_IP;
  });

  it("prefers a platform header a caller cannot forge", () => {
    const identity = clientIp(request({ "cf-connecting-ip": "1.2.3.4", "x-forwarded-for": "9.9.9.9" }));
    expect(identity).toEqual({ ok: true, ip: "1.2.3.4", source: "cf-connecting-ip" });
  });

  it("reads x-forwarded-for from the right, not the left", () => {
    // The caller wrote 9.9.9.9; our proxy appended 1.2.3.4. Reading the left
    // entry would let anyone choose their own rate-limit bucket.
    const identity = clientIp(request({ "x-forwarded-for": "9.9.9.9, 1.2.3.4" }));
    expect(identity).toMatchObject({ ok: true, ip: "1.2.3.4" });
  });

  it("fails closed when no header can be trusted", () => {
    expect(clientIp(request({})).ok).toBe(false);
  });

  it("allows an untrusted address only when development says so", () => {
    process.env.ALLOW_UNTRUSTED_CLIENT_IP = "true";
    expect(clientIp(request({})).ok).toBe(true);
  });
});

describe("hashIp", () => {
  beforeEach(() => {
    process.env.RATE_LIMIT_SALT = "test-salt";
  });

  it("is stable for one address and different across addresses", () => {
    expect(hashIp("1.2.3.4")).toBe(hashIp("1.2.3.4"));
    expect(hashIp("1.2.3.4")).not.toBe(hashIp("1.2.3.5"));
  });

  it("never returns the address itself", () => {
    expect(hashIp("1.2.3.4")).not.toContain("1.2.3.4");
  });

  it("changes completely when the salt changes", () => {
    const before = hashIp("1.2.3.4");
    process.env.RATE_LIMIT_SALT = "another-salt";
    expect(hashIp("1.2.3.4")).not.toBe(before);
  });
});

describe("subnetKey", () => {
  beforeEach(() => {
    process.env.RATE_LIMIT_SALT = "test-salt";
  });

  it("groups an IPv4 /24 together", () => {
    expect(subnetKey("1.2.3.4")).toBe(subnetKey("1.2.3.200"));
    expect(subnetKey("1.2.3.4")).not.toBe(subnetKey("1.2.4.4"));
  });

  it("groups an IPv6 /64 together", () => {
    expect(subnetKey("2001:db8:1:2:3:4:5:6")).toBe(subnetKey("2001:db8:1:2:ffff:ffff:ffff:ffff"));
    expect(subnetKey("2001:db8:1:2::1")).not.toBe(subnetKey("2001:db8:1:3::1"));
  });

  it("treats a compressed IPv6 address as the same prefix as its expanded form", () => {
    expect(subnetKey("2001:db8::1")).toBe(subnetKey("2001:0db8:0000:0000::9"));
  });

  it("is hashed, so it never carries a raw prefix", () => {
    expect(subnetKey("1.2.3.4")).not.toContain("1.2.3");
  });
});

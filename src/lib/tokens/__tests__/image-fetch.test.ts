import { describe, expect, it } from "vitest";
import {
  MAX_IMAGE_BYTES,
  addressAllowed,
  resolveImageUrl,
  sniffImageType,
} from "../image-fetch";

/**
 * The image proxy's refusals, one test each.
 *
 * VALIDATED IN THE NEGATIVE, which is the only way these mean anything. A
 * test that asserts a bad URL is refused passes just as happily against a
 * function that refuses EVERYTHING — including every legitimate logo, which
 * would look like "tokens have no logos" and never like a bug. So every
 * refusal below is paired with the nearest thing that must still be accepted:
 * `arweave.net` beside `169.254.169.254`, `https:` beside `http:`, a real PNG
 * beside a file that merely claims to be one.
 *
 * No network in this file. Everything under test here is a decision, and the
 * decisions are pure.
 */

const REAL = "https://arweave.net/hQiPZOsRZXGXBJd_82PhVdlM_hACsT_q6wqwf5cSY7I";

describe("the URL it will dial", () => {
  it("accepts a real logo URL from a source we use", () => {
    // THE CONTROL for every refusal below. If this ever fails, the refusals
    // stop being evidence of anything.
    const result = resolveImageUrl(REAL);
    expect(result.ok).toBe(true);
  });

  it("accepts every host on the allowlist", () => {
    for (const url of [
      "https://cdn.dexscreener.com/cms/images/abc?width=800",
      "https://arweave.net/abc",
      "https://ipfs.io/ipfs/bafyabc",
      "https://raw.githubusercontent.com/solana-labs/token-list/main/logo.png",
      "https://nftstorage.link/ipfs/bafyabc",
      "https://bafkreibk3covs5ltyqxa272uodhculbr6kea6betidfwy3ajsav2vjzyum.ipfs.nftstorage.link",
    ]) {
      expect(resolveImageUrl(url).ok, url).toBe(true);
    }
  });

  it("accepts the redirect targets the real hosts actually send", () => {
    // MEASURED, not assumed. `arweave.net` answers with a 302 to
    // `<hash>.arweave.net` and `nftstorage.link` with one to
    // `<cid>.ipfs.dweb.link`; content-addressed storage works this way. The
    // redirect loop re-runs `resolveImageUrl` on every hop, so these strings
    // being accepted is exactly what makes following a redirect work — and
    // until the arweave suffix existed, two of the four sources were refused
    // as `redirected` and most tokens silently had no logo.
    for (const url of [
      "https://quei6zhlcfsxdfyes577gy7bkxmuz7qqakyt72xlbkyh7fysmoza.arweave.net/hQiPZOsRZ",
      "https://bafkreibk3covs5ltyqxa272uodhculbr6kea6betidfwy3ajsav2vjzyum.ipfs.dweb.link/",
    ]) {
      expect(resolveImageUrl(url).ok, url).toBe(true);
    }
  });

  it("refuses a redirect that leaves the allowlist, by the same code that checks the first URL", () => {
    // The loop re-derives everything from the URL it is about to dial, so a
    // Location is checked by this function and not by a second, laxer copy.
    // These are the shapes a hostile redirect would take.
    for (const url of [
      "https://evil.example/logo.png",
      "http://arweave.net/abc",
      "https://169.254.169.254/latest/meta-data/",
      "https://arweave.net:8080/abc",
    ]) {
      expect(resolveImageUrl(url).ok, url).toBe(false);
    }
  });

  it("rewrites ipfs:// through the gateway rather than refusing it", () => {
    const result = resolveImageUrl("ipfs://bafyabc/logo.png");
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.url.toString()).toBe("https://ipfs.io/ipfs/bafyabc/logo.png");
  });
});

describe("URLs it refuses", () => {
  const refusals: Array<[string, string, string]> = [
    ["plaintext http", "http://arweave.net/abc", "scheme_not_allowed"],
    ["a file URL", "file:///etc/passwd", "scheme_not_allowed"],
    ["a data URL", "data:image/png;base64,AAAA", "scheme_not_allowed"],
    ["a gopher URL", "gopher://arweave.net/abc", "scheme_not_allowed"],
    ["credentials in the URL", "https://user:pass@arweave.net/abc", "bad_url"],
    ["a host not on the list", "https://evil.example/logo.png", "host_not_allowed"],
    [
      "a host that only looks like one on the list",
      "https://evil-nftstorage.link/logo.png",
      "host_not_allowed",
    ],
    [
      "the allowlist entry used as a prefix",
      "https://arweave.net.evil.example/logo.png",
      "host_not_allowed",
    ],
    ["an allowed host on a strange port", "https://arweave.net:8080/abc", "host_not_allowed"],
    ["localhost", "https://localhost/logo.png", "host_not_allowed"],
    ["the cloud metadata address", "https://169.254.169.254/latest/meta-data/", "host_not_allowed"],
    ["an empty string", "", "bad_url"],
    ["whitespace", "   ", "bad_url"],
    ["not a URL at all", "arweave.net/abc", "bad_url"],
    ["a malformed ipfs reference", "ipfs://../../etc/passwd", "bad_url"],
    ["an absurdly long URL", `https://arweave.net/${"a".repeat(3000)}`, "bad_url"],
  ];

  for (const [name, url, reason] of refusals) {
    it(`refuses ${name}`, () => {
      const result = resolveImageUrl(url);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.reason).toBe(reason);
    });
  }
});

describe("addresses it will connect to", () => {
  it("accepts ordinary public addresses", () => {
    // THE CONTROL. A blocklist that refuses these refuses the whole internet,
    // and every rejection below would be meaningless.
    for (const address of ["1.1.1.1", "8.8.8.8", "104.18.0.1", "2606:4700::6810:85e5"]) {
      expect(addressAllowed(address), address).toBe(true);
    }
  });

  const blocked = [
    ["loopback", "127.0.0.1"],
    ["loopback, another octet", "127.1.2.3"],
    ["link-local, where cloud metadata lives", "169.254.169.254"],
    ["private 10/8", "10.0.0.5"],
    ["private 172.16/12", "172.20.1.1"],
    ["private 192.168/16", "192.168.1.1"],
    ["this-network", "0.0.0.0"],
    ["carrier-grade NAT", "100.64.0.1"],
    ["multicast", "224.0.0.1"],
    ["broadcast", "255.255.255.255"],
    ["IPv6 loopback", "::1"],
    ["IPv6 unspecified", "::"],
    ["IPv6 unique-local", "fd00::1"],
    ["IPv6 link-local", "fe80::1"],
    ["IPv6 multicast", "ff02::1"],
    // The one a v6-only blocklist walks straight past.
    ["a v4-mapped loopback", "::ffff:127.0.0.1"],
    ["a v4-mapped metadata address", "::ffff:169.254.169.254"],
    ["a v4-mapped private address", "::ffff:10.0.0.1"],
    ["a v4-mapped address in hex", "::ffff:7f00:1"],
    ["not an address at all", "not-an-address"],
  ] as const;

  for (const [name, address] of blocked) {
    it(`refuses ${name}`, () => {
      expect(addressAllowed(address)).toBe(false);
    });
  }

  it("refuses a v4-mapped address without refusing v4-mapped public ones", () => {
    // The unwrapping must be a CHECK, not a blanket refusal of the notation.
    expect(addressAllowed("::ffff:1.1.1.1")).toBe(true);
    expect(addressAllowed("::ffff:127.0.0.1")).toBe(false);
  });
});

describe("what counts as an image", () => {
  const png = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    Buffer.alloc(8),
  ]);
  const jpeg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(12)]);
  const gif = Buffer.concat([Buffer.from("GIF89a", "latin1"), Buffer.alloc(12)]);
  const webp = Buffer.concat([
    Buffer.from("RIFF", "latin1"),
    Buffer.alloc(4),
    Buffer.from("WEBP", "latin1"),
    Buffer.alloc(8),
  ]);

  it("names the four formats it serves", () => {
    // THE CONTROL for the refusals below.
    expect(sniffImageType(png)).toBe("image/png");
    expect(sniffImageType(jpeg)).toBe("image/jpeg");
    expect(sniffImageType(gif)).toBe("image/gif");
    expect(sniffImageType(webp)).toBe("image/webp");
  });

  it("refuses SVG, however convincingly it is labelled", () => {
    // Markup, not pixels: it can carry script and remote references, and
    // whether we render untrusted SVG is a question about our own pages.
    expect(sniffImageType(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"></svg>'))).toBeNull();
    expect(sniffImageType(Buffer.from('<?xml version="1.0"?><svg></svg>'))).toBeNull();
  });

  it("refuses HTML, which is what a captive portal or an error page returns", () => {
    expect(sniffImageType(Buffer.from("<!DOCTYPE html><html><body>nope</body></html>"))).toBeNull();
  });

  it("refuses a payload too short to identify", () => {
    expect(sniffImageType(Buffer.from([0x89, 0x50]))).toBeNull();
    expect(sniffImageType(Buffer.alloc(0))).toBeNull();
  });

  it("refuses a file whose extension lies but whose bytes do not", () => {
    // The whole reason the type comes from the bytes: `logo.png` served as
    // `image/png` and containing a zip is a zip.
    expect(sniffImageType(Buffer.concat([Buffer.from("PK"), Buffer.alloc(12)]))).toBeNull();
  });

  it("refuses RIFF that is not WEBP", () => {
    // A .wav is RIFF too. Checking only the first four bytes would serve it
    // as an image.
    const wav = Buffer.concat([
      Buffer.from("RIFF", "latin1"),
      Buffer.alloc(4),
      Buffer.from("WAVE", "latin1"),
      Buffer.alloc(8),
    ]);
    expect(sniffImageType(wav)).toBeNull();
  });
});

describe("the size ceiling", () => {
  it("is a number the route can rely on, and is not enormous", () => {
    // A logo is a small square. Half a megabyte is generous for one and still
    // small enough that a hostile host cannot use us to buffer anything
    // interesting.
    expect(MAX_IMAGE_BYTES).toBe(512 * 1024);
  });
});

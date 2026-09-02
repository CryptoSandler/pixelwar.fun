import { describe, expect, it } from "vitest";
import { makeToken, makeWar, registeredPainter } from "../../../lib/canvas/__tests__/fixtures";
import { GET as canvasRoute } from "../canvas/route";
import { GET as diffRoute } from "../diff/route";
import { GET as leaderboardRoute } from "../leaderboard/route";
import { POST as paintRoute } from "../paint/route";
import { GET as sessionRoute } from "../session/route";

// x-forwarded-for, not cf-connecting-ip: cf-connecting-ip is only trustworthy
// on a deployment that declares itself behind Cloudflare via
// TRUSTED_PLATFORM_HEADER, which nothing sets in this test environment. With
// it unset, clientIp() ignores that header and reads x-forwarded-for instead
// — the path the default configuration actually trusts, and therefore the
// one these tests need to use to keep distinct IPs genuinely distinct.
const HEADERS = { "x-forwarded-for": "1.2.3.4" };

function get(path: string): Request {
  return new Request(`https://pixelwar.fun${path}`, { headers: HEADERS });
}

function post(path: string, body: unknown, cookie?: string, ip = "1.2.3.4"): Request {
  return new Request(`https://pixelwar.fun${path}`, {
    method: "POST",
    headers: {
      "x-forwarded-for": ip,
      "content-type": "application/json",
      ...(cookie ? { cookie } : {}),
    },
    body: JSON.stringify(body),
  });
}

/**
 * A cookie whose painter has registered a wallet.
 *
 * Painting has needed one since migration 012, and a cookieless POST mints a
 * painter key nobody has registered — so every test below that expects a
 * paint to SUCCEED sends one of these. A fresh one per call, because two
 * paints inside one cooldown have to come from two people.
 *
 * Tests that expect a paint to be REFUSED for some other reason deliberately
 * do not send one: those refusals all happen before the registration gate,
 * and a test that satisfied the gate anyway would stop proving that.
 */
async function painter(): Promise<string> {
  return (await registeredPainter()).cookie;
}

/** Pulls the painter cookie out of a Set-Cookie header, for the next request. */
function cookieFrom(response: Response): string {
  const header = response.headers.get("set-cookie")!;
  return header.split(";")[0];
}

/**
 * The colour these tests paint in.
 *
 * Deliberately not the slot of any token the fixtures below create (1, 2, 13):
 * since the free-palette change the painted colour is an independent input,
 * and a test that reused a token's own slot could pass while the two were
 * still secretly wired together.
 */
const PAINT_COLOUR = 7;

describe("GET /api/session", () => {
  it("issues a painter cookie that a script cannot read", async () => {
    const response = await sessionRoute(get("/api/session"));
    const setCookie = response.headers.get("set-cookie")!;
    expect(setCookie).toContain("pw_painter=");
    expect(setCookie).toContain("HttpOnly");
    // Exhaustive on purpose, and kept that way: `toEqual` is what noticed
    // when this response grew an `allegiance` field, and a body that gains
    // fields nobody asserted is how a cookie-identified endpoint starts
    // returning more about a person than anybody decided it should.
    expect(await response.json()).toEqual({
      cooldownUntil: null,
      allegiance: null,
      // Grew when painting started needing a registration. The wallet is null
      // for a browser that has not linked one, and the fee is the number the
      // screen quotes — read from configuration on every call so a deployment
      // that changes it does not have to redeploy the client. This is the
      // default, with REGISTRATION_FEE_SOL unset; setting it in a local env
      // file is what makes this line fail.
      registration: { wallet: null, feeLamports: "3000000", free: false },
    });
  });

  it("does not replace a cookie the caller already has", async () => {
    const first = await sessionRoute(get("/api/session"));
    const cookie = cookieFrom(first);
    const second = await sessionRoute(
      new Request("https://pixelwar.fun/api/session", { headers: { ...HEADERS, cookie } }),
    );
    expect(second.headers.get("set-cookie")).toBeNull();
  });
});

describe("GET /api/canvas", () => {
  // Creating a war, creating a token, and painting are each their own
  // sequential round trips to a remote Neon database; several of them
  // together land close enough to the suite's 5s default to fail
  // intermittently on a slow hop. This and the other route tests below that
  // build real fixtures get their own ceiling rather than raising the suite
  // default for every test in the file.
  it("returns the board as bytes with the sequence in a header", { timeout: 20_000 }, async () => {
    const war = await makeWar({ width: 100, height: 100 });
    const token = await makeToken(war.id, 7);

    const painted = await paintRoute(
      post("/api/paint", { warSlug: war.slug, x: 1, y: 1, tokenId: token, colourSlot: PAINT_COLOUR }, await painter()),
    );
    expect(painted.status).toBe(200);

    const response = await canvasRoute(get(`/api/canvas?war=${war.slug}`));
    expect(response.headers.get("content-type")).toBe("application/octet-stream");
    // The header reports the WAR's width, so the expectation reads it from
    // the war. "8" and 64 were the fixture's old board written out again, and
    // an assertion that restates a fixture cannot notice the fixture changing.
    expect(response.headers.get("x-canvas-width")).toBe(String(war.width));
    expect(response.headers.get("x-canvas-seq")).toBe("1");

    const bytes = new Uint8Array(await response.arrayBuffer());
    expect(bytes).toHaveLength(war.width * war.height);
    expect(bytes[1 * war.width + 1]).toBe(7);
  });

  it("404s for a war that does not exist", async () => {
    expect((await canvasRoute(get("/api/canvas?war=nope"))).status).toBe(404);
  });
});

describe("GET /api/diff", () => {
  it("returns changes after the given sequence", { timeout: 20_000 }, async () => {
    const war = await makeWar({ width: 100, height: 100 });
    const token = await makeToken(war.id, 3);
    await paintRoute(
      post("/api/paint", { warSlug: war.slug, x: 0, y: 0, tokenId: token, colourSlot: PAINT_COLOUR }, await painter()),
    );

    // The default layer is the PAINTED board, so the pair carries the colour
    // the caller chose (7), not the token's own slot (3).
    const response = await diffRoute(get(`/api/diff?war=${war.slug}&since=0`));
    expect(await response.json()).toEqual({
      resync: false,
      seq: 1,
      changes: [[0, PAINT_COLOUR]],
    });
  });

  it("serves owners rather than colours on the token layer", { timeout: 20_000 }, async () => {
    const war = await makeWar({ width: 100, height: 100 });
    const token = await makeToken(war.id, 3);
    await paintRoute(
      post("/api/paint", { warSlug: war.slug, x: 0, y: 0, tokenId: token, colourSlot: PAINT_COLOUR }, await painter()),
    );

    const response = await diffRoute(get(`/api/diff?war=${war.slug}&since=0&layer=token`));
    expect(await response.json()).toEqual({ resync: false, seq: 1, changes: [[0, 3]] });
  });

  it("rejects a non-numeric since rather than guessing", async () => {
    const war = await makeWar();
    expect((await diffRoute(get(`/api/diff?war=${war.slug}&since=abc`))).status).toBe(400);
  });

  it("rejects a since it cannot trust rather than guessing at it", async () => {
    const war = await makeWar();
    for (const since of ["", " ", "+1", "1.5", "-1", "1e9", "9007199254740993"]) {
      const response = await diffRoute(
        get(`/api/diff?war=${war.slug}&since=${encodeURIComponent(since)}`),
      );
      expect(response.status).toBe(400);
    }
  });
});

describe("POST /api/paint", () => {
  it("paints and answers with the new sequence", { timeout: 20_000 }, async () => {
    const war = await makeWar({ width: 100, height: 100 });
    const token = await makeToken(war.id, 2);

    const response = await paintRoute(
      post("/api/paint", { warSlug: war.slug, x: 3, y: 4, tokenId: token, colourSlot: PAINT_COLOUR }, await painter()),
    );
    expect(response.status).toBe(200);
    // The colour that comes back is the one the caller ASKED for, not the
    // one its token happens to hold (2). That difference is the whole change.
    expect(await response.json()).toMatchObject({
      seq: 1, idx: 4 * war.width + 3, colourSlot: PAINT_COLOUR,
    });
  });

  it("answers 429 with Retry-After inside the cooldown", { timeout: 20_000 }, async () => {
    const war = await makeWar({ cooldownSeconds: 30 });
    const token = await makeToken(war.id, 2);

    const cookie = await painter();
    const first = await paintRoute(
      post("/api/paint", { warSlug: war.slug, x: 0, y: 0, tokenId: token, colourSlot: PAINT_COLOUR }, cookie),
    );
    expect(first.status).toBe(200);
    const second = await paintRoute(
      post("/api/paint", { warSlug: war.slug, x: 1, y: 0, tokenId: token, colourSlot: PAINT_COLOUR }, cookie),
    );

    expect(second.status).toBe(429);
    expect(Number(second.headers.get("retry-after"))).toBeGreaterThan(0);
  });

  it("answers 409 once the war has ended", async () => {
    const war = await makeWar({
      status: "live",
      startsAt: new Date(Date.now() - 7_200_000),
      endsAt: new Date(Date.now() - 1_000),
    });
    const token = await makeToken(war.id, 2);

    const response = await paintRoute(post("/api/paint", { warSlug: war.slug, x: 0, y: 0, tokenId: token, colourSlot: PAINT_COLOUR }));
    expect(response.status).toBe(409);
  });

  it("rejects a body with the wrong shape", async () => {
    const war = await makeWar();
    for (const body of [{}, { warSlug: war.slug }, { warSlug: war.slug, x: "1", y: 1, tokenId: "t" }]) {
      expect((await paintRoute(post("/api/paint", body))).status).toBe(400);
    }
  });

  it("rejects a POST whose Origin is a different site", async () => {
    const war = await makeWar();
    const token = await makeToken(war.id, 2);
    const response = await paintRoute(
      new Request("https://pixelwar.fun/api/paint", {
        method: "POST",
        headers: {
          "x-forwarded-for": "1.2.3.4",
          "content-type": "text/plain",
          origin: "https://evil.example",
        },
        body: JSON.stringify({ warSlug: war.slug, x: 0, y: 0, tokenId: token, colourSlot: PAINT_COLOUR }),
      }),
    );
    expect(response.status).toBe(403);
  });

  it("allows a same-origin POST that sends an Origin header", { timeout: 20_000 }, async () => {
    const war = await makeWar();
    const token = await makeToken(war.id, 2);
    const response = await paintRoute(
      new Request("https://pixelwar.fun/api/paint", {
        method: "POST",
        headers: {
          "x-forwarded-for": "1.2.3.4",
          "content-type": "application/json",
          origin: "https://pixelwar.fun",
          cookie: await painter(),
        },
        body: JSON.stringify({ warSlug: war.slug, x: 0, y: 0, tokenId: token, colourSlot: PAINT_COLOUR }),
      }),
    );
    expect(response.status).toBe(200);
  });

  // "paints and answers with the new sequence", above, already covers a POST
  // with no Origin header at all — the ordinary same-origin case — getting
  // through unaffected.

  it("refuses to paint when no client address can be trusted", async () => {
    // Put it back. The suite runs in a single fork, so a variable deleted here
    // stays deleted for every file that runs afterwards — and which files those
    // are depends on alphabetical filename order, which is not a thing any test
    // should silently depend on.
    const previous = process.env.ALLOW_UNTRUSTED_CLIENT_IP;
    delete process.env.ALLOW_UNTRUSTED_CLIENT_IP;

    try {
      const war = await makeWar();
      const token = await makeToken(war.id, 2);
      const response = await paintRoute(
        new Request("https://pixelwar.fun/api/paint", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ warSlug: war.slug, x: 0, y: 0, tokenId: token, colourSlot: PAINT_COLOUR }),
        }),
      );
      expect(response.status).toBe(400);
    } finally {
      if (previous === undefined) delete process.env.ALLOW_UNTRUSTED_CLIENT_IP;
      else process.env.ALLOW_UNTRUSTED_CLIENT_IP = previous;
    }
  });
});

describe("GET /api/leaderboard", () => {
  // Three sequential paints, each its own transaction with several Neon round
  // trips, plus the leaderboard query itself. That is comfortably over the 5s
  // default on a real network hop, so this test gets its own timeout rather
  // than raising the suite default for everything else.
  it("ranks tokens by pixels currently owned", { timeout: 20_000 }, async () => {
    const war = await makeWar({ width: 100, height: 100 });
    const red = await makeToken(war.id, 1);
    const blue = await makeToken(war.id, 13);

    // Three paints inside one cooldown window, so each must come from a
    // different caller — which is exactly what the product requires of a real
    // community. A war with no cooldown is not a thing that can exist: the
    // schema pins cooldown_seconds to 1..3600.
    await paintRoute(post("/api/paint", { warSlug: war.slug, x: 0, y: 0, tokenId: blue, colourSlot: PAINT_COLOUR }, await painter(), "1.2.3.4"));
    await paintRoute(post("/api/paint", { warSlug: war.slug, x: 1, y: 0, tokenId: blue, colourSlot: PAINT_COLOUR }, await painter(), "1.2.3.5"));
    await paintRoute(post("/api/paint", { warSlug: war.slug, x: 2, y: 0, tokenId: red, colourSlot: PAINT_COLOUR }, await painter(), "1.2.3.6"));

    const body = await (await leaderboardRoute(get(`/api/leaderboard?war=${war.slug}`))).json();
    expect(body.tokens.map((t: { colourSlot: number }) => t.colourSlot)).toEqual([13, 1]);
    expect(body.tokens[0].owned).toBe(2);
  });
});

import { generateKeyPairSync, sign as signEd25519 } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import { base58Encode } from "../../../lib/base58";
import { makeToken, makeWar, registeredPainter } from "../../../lib/canvas/__tests__/fixtures";
import { query } from "../../../lib/db";
import { POST as paintRoute } from "../paint/route";
import { POST as challengeRoute } from "../register/challenge/route";
import { POST as linkRoute } from "../register/link/route";
import { POST as registerRoute } from "../register/route";

/**
 * The registration routes.
 *
 * The paying route's own verification is tested in
 * `src/lib/paint/__tests__/registration.test.ts`, where the transaction can
 * be injected. What is tested here is what only a route has: the shapes it
 * refuses, the statuses it returns, and the fact that the paint route turns a
 * missing registration into 402 rather than into a paint.
 */

const HEADERS = { "x-forwarded-for": "9.9.9.9", "content-type": "application/json" };

function post(path: string, body: unknown, cookie?: string): Request {
  return new Request(`https://pixelwar.fun${path}`, {
    method: "POST",
    headers: { ...HEADERS, ...(cookie ? { cookie } : {}) },
    body: JSON.stringify(body),
  });
}

function keypair() {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const raw = publicKey.export({ format: "der", type: "spki" }).subarray(-32);
  return {
    address: base58Encode(new Uint8Array(raw)),
    sign: (message: string) =>
      base58Encode(new Uint8Array(signEd25519(null, Buffer.from(message, "utf8"), privateKey))),
  };
}

beforeEach(() => {
  process.env.PAYMENT_WALLET = "7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU";
  process.env.RATE_LIMIT_SALT = "test-salt";
});

describe("POST /api/register", () => {
  it("rejects a body that is not a signature, without spending an RPC call", async () => {
    for (const body of [{}, { signature: 12 }, { signature: "" }, { signature: "x".repeat(200) }]) {
      expect((await registerRoute(post("/api/register", body))).status).toBe(400);
    }
    // Nothing was recorded as an attempt either: a malformed body never
    // reached the rate limiter, so it cannot be used to exhaust anybody's
    // allowance.
    expect((await query(`SELECT 1 FROM verification_attempts`)).length).toBe(0);
  });

  it("rejects a string that cannot be a signature before touching the network", async () => {
    // Audit finding A-1. The shape check is what the USDC path always had:
    // 87 or 88 base58 characters, 64 bytes decoded. Anything else costs no
    // RPC call and no rate-limit attempt — and there is no fetcher injected
    // here, so a request that DID reach the network would fail differently.
    const response = await registerRoute(
      post("/api/register", { signature: "not-a-signature-but-the-right-sort-of-length" }),
    );
    expect(response.status).toBe(400);
    expect((await response.json()).error).toContain("does not look like");
    expect((await query(`SELECT 1 FROM verification_attempts`)).length).toBe(0);
  });

  it("refuses when the deployment is not settling on mainnet", async () => {
    // Audit finding M-1. The payment screen already declines to open a wallet
    // in this case, but that is the browser being careful; this is the server
    // refusing. A well-shaped signature gets past the check above and stops
    // here, before any RPC call.
    const previous = process.env.SOLANA_RPC_URL;
    process.env.SOLANA_RPC_URL = "https://api.devnet.solana.com";
    try {
      const response = await registerRoute(
        post("/api/register", { signature: "5".repeat(88) }),
      );
      expect(response.status).toBe(503);
      expect((await query(`SELECT 1 FROM verification_attempts`)).length).toBe(0);
    } finally {
      if (previous === undefined) delete process.env.SOLANA_RPC_URL;
      else process.env.SOLANA_RPC_URL = previous;
    }
  });

  it("refuses a cross-site POST", async () => {
    // Audit finding M-2. SameSite=Lax already strips the cookie from such a
    // request, but a forged write still issues challenges and spends budget.
    const response = await registerRoute(
      new Request("https://pixelwar.fun/api/register", {
        method: "POST",
        headers: { ...HEADERS, origin: "https://evil.example" },
        body: JSON.stringify({ signature: "5".repeat(88) }),
      }),
    );
    expect(response.status).toBe(403);
  });
});

describe("POST /api/register/link", () => {
  it("issues a challenge, accepts the signature, and links the browser", async () => {
    const key = keypair();
    // The wallet is registered by fixture rather than by paying: this route
    // is the no-money path and must work without one.
    await query(
      `INSERT INTO registrations (wallet, signature, lamports) VALUES ($1, 'fixture-link', 3000000)`,
      [key.address],
    );

    const challenge = await (await challengeRoute(post("/api/register/challenge", {}))).json();
    const response = await linkRoute(
      post("/api/register/link", {
        wallet: key.address,
        nonce: challenge.nonce,
        signature: key.sign(challenge.message),
      }),
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ wallet: key.address });
    // The browser it linked is the one the cookie in the RESPONSE identifies.
    const cookie = response.headers.get("set-cookie")!;
    expect(cookie).toContain("pw_painter=");
    expect((await query(`SELECT 1 FROM painter_wallets`)).length).toBe(1);
  });

  it("answers 402 for a wallet nobody registered", async () => {
    const key = keypair();
    const challenge = await (await challengeRoute(post("/api/register/challenge", {}))).json();
    const response = await linkRoute(
      post("/api/register/link", {
        wallet: key.address,
        nonce: challenge.nonce,
        signature: key.sign(challenge.message),
      }),
    );

    expect(response.status).toBe(402);
    expect((await response.json()).reason).toBe("not_registered");
  });

  it("rejects a body with the wrong shape", async () => {
    for (const body of [{}, { wallet: "w" }, { wallet: "w", nonce: "n" }, { wallet: 1, nonce: "n", signature: "s" }]) {
      expect((await linkRoute(post("/api/register/link", body))).status).toBe(400);
    }
  });
});

describe("POST /api/paint without a registration", () => {
  it("answers 402 and names the reason the screen acts on", { timeout: 20_000 }, async () => {
    const war = await makeWar({ width: 100, height: 100 });
    const token = await makeToken(war.id, 4);

    const response = await paintRoute(
      post("/api/paint", { warSlug: war.slug, x: 0, y: 0, tokenId: token, colourSlot: 7 }),
    );

    expect(response.status).toBe(402);
    expect((await response.json()).reason).toBe("not_registered");
  });

  it("answers 200 for the same request from a registered painter", { timeout: 20_000 }, async () => {
    // The control. Without it the 402 above would pass just as happily
    // against a route that refused every paint.
    const war = await makeWar({ width: 100, height: 100 });
    const token = await makeToken(war.id, 4);
    const { cookie } = await registeredPainter();

    const response = await paintRoute(
      post("/api/paint", { warSlug: war.slug, x: 0, y: 0, tokenId: token, colourSlot: 7 }, cookie),
    );

    expect(response.status).toBe(200);
  });
});

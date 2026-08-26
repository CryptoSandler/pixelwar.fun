import { randomBytes, randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  ADMIN_COOKIE,
  createAdminSession,
  revokeAdminSession,
} from "../../../lib/admin";
import { base58Encode } from "../../../lib/base58";
import { execute } from "../../../lib/db";
import { GET as orphansRoute } from "../admin/orphans/route";

/**
 * The unmatched-payment surface: `GET /api/admin/orphans` and the
 * `/admin/orphans` screen.
 *
 * Two things are being proven here, and they are the two the brief cares
 * about. First, that the guard is real and that it gives ONE answer: an
 * unauthenticated caller, a caller with a wrong token, a caller with a revoked
 * session and a caller hitting a deployment with no `ADMIN_TOKEN` at all must
 * be indistinguishable, or a prober learns which half of the surface to
 * attack. Second, that what comes out is USDC and not base units — a human
 * reads this while deciding whether to refund real money.
 *
 * These drive the ROUTE and the PAGE, not the reader underneath them
 * (AGENTS.md: the test that catches missing wiring asserts the wiring).
 * Falsified by deleting the `authenticateAdmin` check in the route and the
 * `adminSessionLabel` check in the page — see the report.
 *
 * Every test here writes to Postgres, so every one carries `{ timeout: 20_000 }`.
 */

const TOKEN = "an-admin-secret-for-tests-4a91c7";
const IP = "203.0.113.7";

/**
 * `adminSessionLabel` reads the cookie through `next/headers`, which has no
 * request context in a unit test. The cookie jar is stubbed so the page can be
 * driven directly; everything below it — the session lookup, the revocation
 * check, the `adminConfigured` gate — is the real module.
 */
const cookieJar = { value: null as string | null };

vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) =>
      name === ADMIN_COOKIE && cookieJar.value ? { name, value: cookieJar.value } : undefined,
  }),
}));

/** `redirect()` throws in Next; a sentinel is enough to assert it was reached. */
class Redirected extends Error {
  constructor(public readonly to: string) {
    super(`redirect:${to}`);
  }
}

vi.mock("next/navigation", () => ({
  redirect: (to: string) => {
    throw new Redirected(to);
  },
}));

// Imported after the mocks above so the page picks them up.
const { default: OrphansPage } = await import("../../admin/orphans/page");

function randomSignature(): string {
  return base58Encode(new Uint8Array(randomBytes(64)));
}

function get(headers: Record<string, string> = {}): Request {
  return new Request("https://pixelwar.fun/api/admin/orphans", {
    headers: { "x-forwarded-for": IP, ...headers },
  });
}

/** Files a payment the way `fileUnmatched` would, without going through settlement. */
async function file(options: {
  signature?: string;
  received: string;
  expected: string;
  reason: string;
  createdAt: Date;
  feePayer?: string | null;
}): Promise<string> {
  const signature = options.signature ?? randomSignature();
  await execute(
    `INSERT INTO unmatched_payments
       (id, signature, order_id, received_base_units, expected_base_units, reason, created_at,
        sender_fee_payer, sender_debited)
     VALUES ($1,$2,NULL,$3,$4,$5,$6,$7,'[]'::jsonb)`,
    [
      randomUUID(),
      signature,
      options.received,
      options.expected,
      options.reason,
      options.createdAt,
      options.feePayer ?? null,
    ],
  );
  return signature;
}

/** Status, body and headers together — what a prober can actually observe. */
async function shape(response: Response) {
  return {
    status: response.status,
    body: await response.text(),
    headers: [...response.headers].sort(),
  };
}

beforeEach(() => {
  vi.unstubAllEnvs();
  vi.stubEnv("ADMIN_TOKEN", TOKEN);
  cookieJar.value = null;
});

describe("GET /api/admin/orphans", () => {
  it(
    "answers an unauthenticated request exactly as it answers a wrong token",
    { timeout: 20_000 },
    async () => {
      const anonymous = await shape(await orphansRoute(get()));
      const wrongToken = await shape(await orphansRoute(get({ "x-admin-token": "not-the-token" })));
      const junkCookie = await shape(await orphansRoute(get({ cookie: `${ADMIN_COOKIE}=nonsense` })));

      expect(anonymous.status).toBe(401);
      expect(wrongToken).toEqual(anonymous);
      expect(junkCookie).toEqual(anonymous);
      expect(anonymous.body).not.toContain("orphans");
    },
  );

  it("answers a revoked session the same way", { timeout: 20_000 }, async () => {
    const session = await createAdminSession("admin", "hashed");
    await revokeAdminSession(session.id);

    const revoked = await shape(
      await orphansRoute(get({ cookie: `${ADMIN_COOKIE}=${session.id}` })),
    );
    const anonymous = await shape(await orphansRoute(get()));

    // Both halves asserted, not just their equality: two unguarded 200s are
    // also equal to each other, and that is exactly the bug this is for.
    expect(revoked.status).toBe(401);
    expect(revoked).toEqual(anonymous);
  });

  it(
    "refuses everything when ADMIN_TOKEN is unset, including the right token",
    { timeout: 20_000 },
    async () => {
      // A live session minted while the token was set must not survive it
      // being cleared: unset means closed, never open.
      const session = await createAdminSession("admin", "hashed");
      await file({ received: "25000000", expected: "25000000", reason: "war_full", createdAt: new Date() });

      vi.unstubAllEnvs();

      const withToken = await shape(await orphansRoute(get({ "x-admin-token": TOKEN })));
      const withSession = await shape(
        await orphansRoute(get({ cookie: `${ADMIN_COOKIE}=${session.id}` })),
      );
      const anonymous = await shape(await orphansRoute(get()));

      expect(withToken.status).toBe(401);
      expect(withSession.status).toBe(401);
      expect(anonymous.status).toBe(401);
      expect(withToken).toEqual(anonymous);
      expect(withSession).toEqual(anonymous);
      // The filed row exists; a refusal that leaked it would say so.
      expect(withToken.body).not.toContain("war_full");
    },
  );

  it("lists filed payments newest first, as USDC", { timeout: 20_000 }, async () => {
    const older = await file({
      received: "25000000",
      expected: "25000000",
      reason: "war_full",
      createdAt: new Date("2026-08-20T10:00:00Z"),
    });
    const newer = await file({
      // 12.5 USDC against a 25 USDC price: an underpayment, and the case where
      // showing base units would be actively misleading.
      received: "12500000",
      expected: "25000000",
      reason: "insufficient_amount",
      createdAt: new Date("2026-08-22T10:00:00Z"),
      feePayer: "7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU",
    });

    const session = await createAdminSession("admin", "hashed");
    const response = await orphansRoute(get({ cookie: `${ADMIN_COOKIE}=${session.id}` }));
    expect(response.status).toBe(200);

    const body = (await response.json()) as {
      orphans: { signature: string; receivedUsdc: string; expectedUsdc: string; reason: string }[];
    };

    expect(body.orphans.map((o) => o.signature)).toEqual([newer, older]);
    expect(body.orphans[0]).toMatchObject({
      receivedUsdc: "12.50",
      expectedUsdc: "25.00",
      reason: "insufficient_amount",
      senderFeePayer: "7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU",
    });

    // Base units never reach a human. The raw u64 strings must be absent from
    // the whole payload, not merely absent from the field we happened to read.
    const raw = JSON.stringify(body);
    expect(raw).not.toContain("12500000");
    expect(raw).not.toContain("25000000");
  });

  it("never returns the token or the session id", { timeout: 20_000 }, async () => {
    await file({ received: "25000000", expected: "25000000", reason: "war_closed", createdAt: new Date() });
    const session = await createAdminSession("admin", "hashed");

    const body = await orphansRoute(get({ cookie: `${ADMIN_COOKIE}=${session.id}` })).then((r) =>
      r.text(),
    );

    expect(body).not.toContain(TOKEN);
    expect(body).not.toContain(session.id);
  });
});

describe("/admin/orphans", () => {
  it("redirects a signed-out visitor to /admin", { timeout: 20_000 }, async () => {
    await expect(OrphansPage()).rejects.toThrow(Redirected);
    await expect(OrphansPage()).rejects.toMatchObject({ to: "/admin" });
  });

  it("redirects a revoked session to the same place", { timeout: 20_000 }, async () => {
    const session = await createAdminSession("admin", "hashed");
    await revokeAdminSession(session.id);
    cookieJar.value = session.id;

    await expect(OrphansPage()).rejects.toMatchObject({ to: "/admin" });
  });

  it(
    "redirects even a live session once ADMIN_TOKEN is unset",
    { timeout: 20_000 },
    async () => {
      const session = await createAdminSession("admin", "hashed");
      cookieJar.value = session.id;
      vi.unstubAllEnvs();

      await expect(OrphansPage()).rejects.toMatchObject({ to: "/admin" });
    },
  );

  it("renders the filed payments for a signed-in operator", { timeout: 20_000 }, async () => {
    const signature = await file({
      received: "12500000",
      expected: "25000000",
      reason: "insufficient_amount",
      createdAt: new Date("2026-08-22T10:00:00Z"),
    });

    const session = await createAdminSession("admin", "hashed");
    cookieJar.value = session.id;

    const { renderToStaticMarkup } = await import("react-dom/server");
    const html = renderToStaticMarkup(await OrphansPage());

    expect(html).toContain(signature);
    expect(html).toContain("12.50 USDC");
    expect(html).toContain("25.00 USDC");
    expect(html).toContain("2026-08-22 10:00:00 UTC");
    // The reason, in words as well as in code.
    expect(html).toContain("Less than the entry price arrived.");
    expect(html).toContain("insufficient_amount");
    // Base units are not what a person deciding on a refund should read.
    expect(html).not.toContain("12500000");
    // DESIGN.md §3: every number is monospaced, and §9: quiet text is a named
    // colour. Neither is expressible as a raw value here, so what is asserted
    // is that the classes carrying them are actually applied.
    expect(html).toContain("numeric");
    expect(html).toContain("muted");
    expect(html).not.toContain("opacity");
  });
});

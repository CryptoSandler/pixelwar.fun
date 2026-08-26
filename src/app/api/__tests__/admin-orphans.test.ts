import { randomBytes, randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  ADMIN_COOKIE,
  createAdminSession,
  revokeAdminSession,
} from "../../../lib/admin";
import { base58Encode } from "../../../lib/base58";
import { execute, query } from "../../../lib/db";
import { GET as orphansRoute } from "../admin/orphans/route";
import { POST as assignRoute } from "../admin/orphans/[id]/assign/route";
import { POST as discardRoute } from "../admin/orphans/[id]/discard/route";

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

/** The page takes `searchParams` like any Next 16 page; tests never pass any. */
function pageProps(search: Record<string, string> = {}) {
  return { searchParams: Promise.resolve(search) };
}

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
  /** The order the payment was SUBMITTED against, when the filing path had one. */
  orderId?: string | null;
}): Promise<string> {
  const signature = options.signature ?? randomSignature();
  await execute(
    `INSERT INTO unmatched_payments
       (id, signature, order_id, received_base_units, expected_base_units, reason, created_at,
        sender_fee_payer, sender_debited)
     VALUES ($1,$2,$8,$3,$4,$5,$6,$7,'[]'::jsonb)`,
    [
      randomUUID(),
      signature,
      options.received,
      options.expected,
      options.reason,
      options.createdAt,
      options.feePayer ?? null,
      options.orderId ?? null,
    ],
  );
  return signature;
}

/** A live war, a reserved colour, and the order that would pay for it. */
async function orderFixture(options: {
  tokenStatus?: "reserved" | "released";
  orderStatus?: "pending" | "expired" | "paid";
  /** The war's own state, for the checks that are about the war and not the seat. */
  warStatus?: string;
  /** Set in the past to make the war over by its own clock rather than by status. */
  warEndsAt?: string;
  /** 1 makes this war exactly full once its single token is counted. */
  maxTokens?: number;
} = {}) {
  const warId = randomUUID();
  const tokenId = randomUUID();
  const orderId = randomUUID();
  const tokenStatus = options.tokenStatus ?? "reserved";
  const orderStatus = options.orderStatus ?? "pending";

  await execute(
    `INSERT INTO wars (id, slug, title, status, width, height, max_tokens,
                       entry_price_usd, cooldown_seconds, starts_at, ends_at)
     VALUES ($1,$1,'Fixture war',$2,8,8,$3,25,30, now() - interval '1 hour',
             now() + ($4 || ' minutes')::interval)`,
    [warId, options.warStatus ?? "live", options.maxTokens ?? 24, options.warEndsAt ?? "60"],
  );
  await execute(
    `INSERT INTO war_tokens
       (id, war_id, chain_id, contract, contract_key, colour_slot, status,
        name, ticker, metadata_fetched_at, reserved_at, released_at, released_reason)
     VALUES ($1,$2,'solana',$1,$1,7,$3,'Fixture','FIX', now(), now(),
             CASE WHEN $3 = 'released' THEN now() ELSE NULL END,
             CASE WHEN $3 = 'released' THEN 'order_expired' ELSE NULL END)`,
    [tokenId, warId, tokenStatus],
  );
  await execute(
    `INSERT INTO entry_orders
       (id, war_id, war_token_id, amount_usd, payer_pubkey, reference_pubkey, status,
        created_at, expires_at)
     VALUES ($1,$2,$3,25,NULL,$1,$4, now() - interval '40 minutes', now() - interval '10 minutes')`,
    [orderId, warId, tokenId, orderStatus],
  );

  return { warId, tokenId, orderId };
}

/** The id of the row `file()` just wrote, by signature. */
async function orphanIdFor(signature: string): Promise<string> {
  const rows = await query<{ id: string }>(
    `SELECT id FROM unmatched_payments WHERE signature = $1`,
    [signature],
  );
  return rows[0].id;
}

function assignRequest(
  orphanId: string,
  orderId: string,
  headers: Record<string, string> = {},
): [Request, { params: Promise<{ id: string }> }] {
  return [
    new Request(`https://pixelwar.fun/api/admin/orphans/${orphanId}/assign`, {
      method: "POST",
      headers: { "x-forwarded-for": IP, ...headers },
      body: new URLSearchParams({ orderId }),
    }),
    { params: Promise.resolve({ id: orphanId }) },
  ];
}

function discardRequest(
  orphanId: string,
  note: string,
  headers: Record<string, string> = {},
): [Request, { params: Promise<{ id: string }> }] {
  return [
    new Request(`https://pixelwar.fun/api/admin/orphans/${orphanId}/discard`, {
      method: "POST",
      headers: { "x-forwarded-for": IP, ...headers },
      body: new URLSearchParams({ note }),
    }),
    { params: Promise.resolve({ id: orphanId }) },
  ];
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
    await expect(OrphansPage(pageProps())).rejects.toThrow(Redirected);
    await expect(OrphansPage(pageProps())).rejects.toMatchObject({ to: "/admin" });
  });

  it("redirects a revoked session to the same place", { timeout: 20_000 }, async () => {
    const session = await createAdminSession("admin", "hashed");
    await revokeAdminSession(session.id);
    cookieJar.value = session.id;

    await expect(OrphansPage(pageProps())).rejects.toMatchObject({ to: "/admin" });
  });

  it(
    "redirects even a live session once ADMIN_TOKEN is unset",
    { timeout: 20_000 },
    async () => {
      const session = await createAdminSession("admin", "hashed");
      cookieJar.value = session.id;
      vi.unstubAllEnvs();

      await expect(OrphansPage(pageProps())).rejects.toMatchObject({ to: "/admin" });
    },
  );

  it("renders the filed payments for a signed-in operator", { timeout: 20_000 }, async () => {
    // An assignable order exists, so the assign form renders rather than the
    // "nothing can take a payment" line. The discard form does not depend on
    // one — discarding never needs an order.
    await orderFixture();
    const signature = await file({
      received: "12500000",
      expected: "25000000",
      reason: "insufficient_amount",
      createdAt: new Date("2026-08-22T10:00:00Z"),
    });

    const session = await createAdminSession("admin", "hashed");
    cookieJar.value = session.id;

    const { renderToStaticMarkup } = await import("react-dom/server");
    const html = renderToStaticMarkup(await OrphansPage(pageProps()));

    expect(html).toContain(signature);
    // Both actions are on the row, and this is the assertion that catches a
    // route nothing calls (AGENTS.md): the form's own action attribute.
    const orphanId = await orphanIdFor(signature);
    expect(html).toContain(`/api/admin/orphans/${orphanId}/assign`);
    expect(html).toContain(`/api/admin/orphans/${orphanId}/discard`);
    expect(html).toContain('name="note"');
    expect(html).toContain("12.50 USDC");
    // The RECEIVED amount is on the card. The order price deliberately is NOT,
    // because this row names no order — see the next test. A price shown here
    // would be a number the operator reads as the comparison that matters,
    // and it is the wrong comparison in exactly the reunite-with-a-different-
    // order case this screen exists for.
    expect(html).not.toContain("25.00 USDC");
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

  it(
    "shows the order price beside the order it belongs to, never beside the picker",
    { timeout: 20_000 },
    async () => {
      const { orderId } = await orderFixture();
      await file({
        received: "12500000",
        expected: "25000000",
        reason: "insufficient_amount",
        createdAt: new Date("2026-08-22T10:00:00Z"),
        orderId,
      });

      const session = await createAdminSession("admin", "hashed");
      cookieJar.value = session.id;

      const { renderToStaticMarkup } = await import("react-dom/server");
      const html = renderToStaticMarkup(await OrphansPage(pageProps()));

      // Present, but only as a fact about the order it was submitted against.
      expect(html).toContain("Submitted against order");
      expect(html).toContain("That order\u2019s price was");
      expect(html).toContain("25.00 USDC");
      // And never as a bare labelled figure next to the received amount, which
      // is what read as "compare these two" and was wrong whenever the
      // operator picks a different order.
      expect(html).not.toContain("Order price");
      // What replaces it: the operator is told plainly that nothing checks the
      // amount for them.
      expect(html).toContain("The amount is not checked against the order you pick.");
    },
  );
});

/**
 * The one endpoint in this project that moves money on a human's say-so.
 *
 * What these prove, in order: that it is guarded like everything else; that it
 * settles through the payer's own settlement rather than beside it (payment
 * row + order paid + token active, together); that a double-click cannot
 * settle twice; that the same signature cannot pay two orders; and that a
 * human's say-so is not an exemption from the war's own rules.
 */
describe("POST /api/admin/orphans/[id]/assign", () => {
  it(
    "answers an unauthenticated request exactly as it answers a wrong token, and settles nothing",
    { timeout: 20_000 },
    async () => {
      const { orderId } = await orderFixture();
      const signature = await file({
        received: "25000000",
        expected: "25000000",
        reason: "war_full",
        createdAt: new Date(),
      });
      const orphanId = await orphanIdFor(signature);

      const anonymous = await shape(await assignRoute(...assignRequest(orphanId, orderId)));
      const wrongToken = await shape(
        await assignRoute(...assignRequest(orphanId, orderId, { "x-admin-token": "not-the-token" })),
      );
      const junkCookie = await shape(
        await assignRoute(...assignRequest(orphanId, orderId, { cookie: `${ADMIN_COOKIE}=nonsense` })),
      );

      expect(anonymous.status).toBe(401);
      expect(wrongToken).toEqual(anonymous);
      expect(junkCookie).toEqual(anonymous);

      // The guard runs before anything is read or written. Nothing moved.
      expect(await query(`SELECT id FROM payments`)).toHaveLength(0);
      expect(await query(`SELECT status FROM unmatched_payments WHERE id = $1`, [orphanId])).toEqual([
        { status: "open" },
      ]);
      expect(await query(`SELECT status FROM entry_orders WHERE id = $1`, [orderId])).toEqual([
        { status: "pending" },
      ]);
    },
  );

  it(
    "settles the payment, the order and the colour together, and records who did it",
    { timeout: 20_000 },
    async () => {
      const { orderId, tokenId } = await orderFixture();
      const signature = await file({
        received: "25000000",
        expected: "25000000",
        reason: "war_full",
        createdAt: new Date(),
        feePayer: "7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU",
      });
      const orphanId = await orphanIdFor(signature);
      const session = await createAdminSession("admin", "hashed");

      const response = await assignRoute(
        ...assignRequest(orphanId, orderId, { cookie: `${ADMIN_COOKIE}=${session.id}` }),
      );
      expect(response.status).toBe(200);
      // USDC on the way out, never base units.
      expect(await response.json()).toEqual({ ok: true, orderId, amountUsdc: "25.00" });

      // The settlement trio, all three, from the payer's own code path.
      expect(
        await query(`SELECT signature, order_id, amount_base_units, payer FROM payments`),
      ).toEqual([
        {
          signature,
          order_id: orderId,
          amount_base_units: "25000000",
          // The chain's fee payer, not the order's payer_pubkey (which is NULL
          // here). An operator must never be shown a claim nobody on chain made.
          payer: "7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU",
        },
      ]);
      expect(await query(`SELECT status FROM entry_orders WHERE id = $1`, [orderId])).toEqual([
        { status: "paid" },
      ]);
      expect(await query(`SELECT status FROM war_tokens WHERE id = $1`, [tokenId])).toEqual([
        { status: "active" },
      ]);

      // The audit answer: which operator, on the same row, in the same act.
      const [row] = await query<{ status: string; applied_by: string; applied_order_id: string }>(
        `SELECT status, applied_by, applied_order_id FROM unmatched_payments WHERE id = $1`,
        [orphanId],
      );
      expect(row).toEqual({ status: "applied", applied_by: "admin", applied_order_id: orderId });
    },
  );

  it(
    "is idempotent under a double-click: the second request settles nothing",
    { timeout: 20_000 },
    async () => {
      const { orderId } = await orderFixture();
      const signature = await file({
        received: "25000000",
        expected: "25000000",
        reason: "war_full",
        createdAt: new Date(),
      });
      const orphanId = await orphanIdFor(signature);
      const session = await createAdminSession("admin", "hashed");
      const cookie = { cookie: `${ADMIN_COOKIE}=${session.id}` };

      const first = await assignRoute(...assignRequest(orphanId, orderId, cookie));
      const second = await assignRoute(...assignRequest(orphanId, orderId, cookie));

      expect(first.status).toBe(200);
      expect(second.status).toBe(409);
      expect(await second.json()).toMatchObject({ reason: "already_resolved" });

      // ONE payment row. This is the assertion the whole endpoint exists to
      // keep true: a signature cannot be settled twice.
      expect(await query(`SELECT id FROM payments`)).toHaveLength(1);
    },
  );

  it(
    "settles nothing when two clicks land at once",
    { timeout: 20_000 },
    async () => {
      const { orderId } = await orderFixture();
      const signature = await file({
        received: "25000000",
        expected: "25000000",
        reason: "war_full",
        createdAt: new Date(),
      });
      const orphanId = await orphanIdFor(signature);
      const session = await createAdminSession("admin", "hashed");
      const cookie = { cookie: `${ADMIN_COOKIE}=${session.id}` };

      // Genuinely concurrent, not sequential: both requests are in flight
      // before either commits, which is the case a status check would lose to
      // and the FOR UPDATE lock on the unmatched_payments row is there for.
      const [a, b] = await Promise.all([
        assignRoute(...assignRequest(orphanId, orderId, cookie)),
        assignRoute(...assignRequest(orphanId, orderId, cookie)),
      ]);

      expect([a.status, b.status].sort()).toEqual([200, 409]);
      expect(await query(`SELECT id FROM payments`)).toHaveLength(1);
      expect(await query(`SELECT status FROM entry_orders WHERE id = $1`, [orderId])).toEqual([
        { status: "paid" },
      ]);
    },
  );

  it(
    "refuses to spend one signature on a second order",
    { timeout: 20_000 },
    async () => {
      const first = await orderFixture();
      const second = await orderFixture();
      const signature = await file({
        received: "25000000",
        expected: "25000000",
        reason: "war_full",
        createdAt: new Date(),
      });
      const orphanId = await orphanIdFor(signature);
      const session = await createAdminSession("admin", "hashed");
      const cookie = { cookie: `${ADMIN_COOKIE}=${session.id}` };

      expect((await assignRoute(...assignRequest(orphanId, first.orderId, cookie))).status).toBe(200);

      // The row is closed, so this stops at the idempotency lock. Re-opening it
      // by hand is the only way to reach the ledger constraint underneath, and
      // that constraint is the thing worth proving: even with the application
      // check defeated, `payments.signature UNIQUE` refuses the second write.
      await execute(`UPDATE unmatched_payments SET status = 'open' WHERE id = $1`, [orphanId]);

      const response = await assignRoute(...assignRequest(orphanId, second.orderId, cookie));
      expect(response.status).toBe(409);
      expect(await response.json()).toMatchObject({ reason: "signature_settled" });

      // And the rollback is whole: the second order's colour was flipped to
      // active inside that transaction before the ledger refused it, and must
      // not have survived.
      expect(await query(`SELECT id FROM payments`)).toHaveLength(1);
      expect(await query(`SELECT status FROM entry_orders WHERE id = $1`, [second.orderId])).toEqual([
        { status: "pending" },
      ]);
      expect(await query(`SELECT status FROM war_tokens WHERE id = $1`, [second.tokenId])).toEqual([
        { status: "reserved" },
      ]);
    },
  );

  it("refuses an order that is already paid", { timeout: 20_000 }, async () => {
    const { orderId } = await orderFixture({ orderStatus: "paid" });
    const signature = await file({
      received: "25000000",
      expected: "25000000",
      reason: "war_full",
      createdAt: new Date(),
    });
    const orphanId = await orphanIdFor(signature);
    const session = await createAdminSession("admin", "hashed");

    const response = await assignRoute(
      ...assignRequest(orphanId, orderId, { cookie: `${ADMIN_COOKIE}=${session.id}` }),
    );
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ reason: "order_not_assignable" });
    expect(await query(`SELECT id FROM payments`)).toHaveLength(0);
  });

  it(
    "will not seat a token whose colour someone else took while it waited",
    { timeout: 20_000 },
    async () => {
      // An expired order: its reservation released the colour, and somebody
      // else has since taken it. A human's say-so is authorisation, never an
      // exemption from the war's own rules — same check a payer's late confirm
      // faces, same code.
      const { warId, orderId, tokenId } = await orderFixture({
        tokenStatus: "released",
        orderStatus: "expired",
      });
      await execute(
        `INSERT INTO war_tokens
           (id, war_id, chain_id, contract, contract_key, colour_slot, status,
            name, ticker, metadata_fetched_at, reserved_at, joined_at)
         VALUES ($1,$2,'solana',$1,$1,7,'active','Rival','RIV', now(), now(), now())`,
        [randomUUID(), warId],
      );

      const signature = await file({
        received: "25000000",
        expected: "25000000",
        reason: "late_confirm_past_grace",
        createdAt: new Date(),
      });
      const orphanId = await orphanIdFor(signature);
      const session = await createAdminSession("admin", "hashed");

      const response = await assignRoute(
        ...assignRequest(orphanId, orderId, { cookie: `${ADMIN_COOKIE}=${session.id}` }),
      );
      expect(response.status).toBe(409);
      expect(await response.json()).toMatchObject({ reason: "colour_taken" });

      expect(await query(`SELECT id FROM payments`)).toHaveLength(0);
      expect(await query(`SELECT status FROM war_tokens WHERE id = $1`, [tokenId])).toEqual([
        { status: "released" },
      ]);
      expect(await query(`SELECT status FROM unmatched_payments WHERE id = $1`, [orphanId])).toEqual([
        { status: "open" },
      ]);
    },
  );

  it(
    "reclaims a released colour when nothing else has taken it",
    { timeout: 20_000 },
    async () => {
      const { orderId, tokenId } = await orderFixture({
        tokenStatus: "released",
        orderStatus: "expired",
      });
      const signature = await file({
        received: "25000000",
        expected: "25000000",
        reason: "late_confirm_past_grace",
        createdAt: new Date(),
      });
      const orphanId = await orphanIdFor(signature);
      const session = await createAdminSession("admin", "hashed");

      const response = await assignRoute(
        ...assignRequest(orphanId, orderId, { cookie: `${ADMIN_COOKIE}=${session.id}` }),
      );
      expect(response.status).toBe(200);

      // Past LATE_CONFIRM_GRACE_MINUTES, which is deliberately not a bound on
      // this path: the grace window governs what happens automatically, and a
      // human looking at a filed payment later is what this screen is for.
      expect(await query(`SELECT status, released_at FROM war_tokens WHERE id = $1`, [tokenId])).toEqual(
        [{ status: "active", released_at: null }],
      );
    },
  );

  /**
   * The war checks, which are what the dropped grace window rests on.
   *
   * "Authorisation, never an exemption from the war's own rules" was true of
   * the `expired` branch and false of the `pending` one until a review found
   * it: the `pending` branch took no war check at all, so an operator could
   * seat a token into a war that ended months ago. These four cover both
   * branches, both refusals, and — the case that makes the fix non-obvious —
   * the full war that must still accept its own last payment.
   */
  it(
    "refuses a pending order in a war that has ended",
    { timeout: 20_000 },
    async () => {
      // Over by its own clock, which is the case `expireStaleOrders` cannot
      // help with: nothing closes a war's orders when the war ends.
      const { orderId, tokenId } = await orderFixture({ warEndsAt: "-30" });
      const signature = await file({
        received: "25000000",
        expected: "25000000",
        reason: "war_full",
        createdAt: new Date(),
      });
      const orphanId = await orphanIdFor(signature);
      const session = await createAdminSession("admin", "hashed");

      const response = await assignRoute(
        ...assignRequest(orphanId, orderId, { cookie: `${ADMIN_COOKIE}=${session.id}` }),
      );
      expect(response.status).toBe(409);
      expect(await response.json()).toMatchObject({ reason: "war_closed" });

      expect(await query(`SELECT id FROM payments`)).toHaveLength(0);
      expect(await query(`SELECT status FROM entry_orders WHERE id = $1`, [orderId])).toEqual([
        { status: "pending" },
      ]);
      expect(await query(`SELECT status FROM war_tokens WHERE id = $1`, [tokenId])).toEqual([
        { status: "reserved" },
      ]);
      expect(await query(`SELECT status FROM unmatched_payments WHERE id = $1`, [orphanId])).toEqual([
        { status: "open" },
      ]);
    },
  );

  it(
    "refuses a pending order in a war that was cancelled",
    { timeout: 20_000 },
    async () => {
      const { orderId } = await orderFixture({ warStatus: "cancelled" });
      const signature = await file({
        received: "25000000",
        expected: "25000000",
        reason: "war_full",
        createdAt: new Date(),
      });
      const orphanId = await orphanIdFor(signature);
      const session = await createAdminSession("admin", "hashed");

      const response = await assignRoute(
        ...assignRequest(orphanId, orderId, { cookie: `${ADMIN_COOKIE}=${session.id}` }),
      );
      expect(response.status).toBe(409);
      expect(await response.json()).toMatchObject({ reason: "war_closed" });
      expect(await query(`SELECT id FROM payments`)).toHaveLength(0);
    },
  );

  it(
    "still settles a pending order in a war that is exactly full",
    { timeout: 20_000 },
    async () => {
      // The reason the fix is `warIsOpen` and not `warHasRoom`. This war seats
      // one token and that token is this order's own reserved seat, so the
      // capacity count (`status <> 'released'`) already includes it. Asking
      // about capacity here would refuse a perfectly legitimate payment for a
      // seat the war is already holding.
      const { orderId, tokenId } = await orderFixture({ maxTokens: 1 });
      const signature = await file({
        received: "25000000",
        expected: "25000000",
        reason: "war_full",
        createdAt: new Date(),
      });
      const orphanId = await orphanIdFor(signature);
      const session = await createAdminSession("admin", "hashed");

      const response = await assignRoute(
        ...assignRequest(orphanId, orderId, { cookie: `${ADMIN_COOKIE}=${session.id}` }),
      );
      expect(response.status).toBe(200);
      expect(await query(`SELECT status FROM war_tokens WHERE id = $1`, [tokenId])).toEqual([
        { status: "active" },
      ]);
    },
  );

  it(
    "refuses an expired order in a war that has ended",
    { timeout: 20_000 },
    async () => {
      const { orderId, tokenId } = await orderFixture({
        tokenStatus: "released",
        orderStatus: "expired",
        warEndsAt: "-30",
      });
      const signature = await file({
        received: "25000000",
        expected: "25000000",
        reason: "late_confirm_past_grace",
        createdAt: new Date(),
      });
      const orphanId = await orphanIdFor(signature);
      const session = await createAdminSession("admin", "hashed");

      const response = await assignRoute(
        ...assignRequest(orphanId, orderId, { cookie: `${ADMIN_COOKIE}=${session.id}` }),
      );
      expect(response.status).toBe(409);
      expect(await response.json()).toMatchObject({ reason: "war_closed" });

      expect(await query(`SELECT id FROM payments`)).toHaveLength(0);
      expect(await query(`SELECT status FROM war_tokens WHERE id = $1`, [tokenId])).toEqual([
        { status: "released" },
      ]);
    },
  );

  it(
    "refuses an expired order whose war filled while it waited",
    { timeout: 20_000 },
    async () => {
      // Here the seat IS being added back, so capacity is the right question:
      // one seat, already taken by somebody else, and this released row would
      // be the second.
      const { warId, orderId, tokenId } = await orderFixture({
        tokenStatus: "released",
        orderStatus: "expired",
        maxTokens: 1,
      });
      await execute(
        `INSERT INTO war_tokens
           (id, war_id, chain_id, contract, contract_key, colour_slot, status,
            name, ticker, metadata_fetched_at, reserved_at, joined_at)
         VALUES ($1,$2,'solana',$1,$1,11,'active','Rival','RIV', now(), now(), now())`,
        [randomUUID(), warId],
      );

      const signature = await file({
        received: "25000000",
        expected: "25000000",
        reason: "late_confirm_past_grace",
        createdAt: new Date(),
      });
      const orphanId = await orphanIdFor(signature);
      const session = await createAdminSession("admin", "hashed");

      const response = await assignRoute(
        ...assignRequest(orphanId, orderId, { cookie: `${ADMIN_COOKIE}=${session.id}` }),
      );
      expect(response.status).toBe(409);
      expect(await response.json()).toMatchObject({ reason: "war_full" });

      expect(await query(`SELECT id FROM payments`)).toHaveLength(0);
      expect(await query(`SELECT status FROM war_tokens WHERE id = $1`, [tokenId])).toEqual([
        { status: "released" },
      ]);
    },
  );

  it("answers a browser with a redirect, not JSON", { timeout: 20_000 }, async () => {
    const { orderId } = await orderFixture();
    const signature = await file({
      received: "25000000",
      expected: "25000000",
      reason: "war_full",
      createdAt: new Date(),
    });
    const orphanId = await orphanIdFor(signature);
    const session = await createAdminSession("admin", "hashed");

    const response = await assignRoute(
      ...assignRequest(orphanId, orderId, {
        cookie: `${ADMIN_COOKIE}=${session.id}`,
        accept: "text/html,application/xhtml+xml",
      }),
    );

    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe("/admin/orphans?applied=1");
  });
});

/**
 * The other half of the screen, and the more common outcome.
 *
 * Most stray payments are somebody's mistake and end in a refund, so without
 * a way to mark one handled the queue could only ever grow. What these prove:
 * that it is guarded exactly like the assign route; that it settles NOTHING —
 * no payment row, no order status, no colour; that a note is required, because
 * a discarded payment with no reason is an audit trail that says nothing; that
 * a double-click cannot discard twice; and that a discarded row can never be
 * assigned afterwards by any path.
 */
describe("POST /api/admin/orphans/[id]/discard", () => {
  it(
    "answers an unauthenticated request exactly as it answers a wrong token, and changes nothing",
    { timeout: 20_000 },
    async () => {
      const signature = await file({
        received: "25000000",
        expected: "25000000",
        reason: "war_full",
        createdAt: new Date(),
      });
      const orphanId = await orphanIdFor(signature);
      const note = "Refunded on chain.";

      const anonymous = await shape(await discardRoute(...discardRequest(orphanId, note)));
      const wrongToken = await shape(
        await discardRoute(...discardRequest(orphanId, note, { "x-admin-token": "not-the-token" })),
      );
      const junkCookie = await shape(
        await discardRoute(...discardRequest(orphanId, note, { cookie: `${ADMIN_COOKIE}=nonsense` })),
      );

      expect(anonymous.status).toBe(401);
      expect(wrongToken).toEqual(anonymous);
      expect(junkCookie).toEqual(anonymous);

      expect(await query(`SELECT status FROM unmatched_payments WHERE id = $1`, [orphanId])).toEqual([
        { status: "open" },
      ]);
    },
  );

  it(
    "marks the payment handled with the operator and the note, and settles nothing",
    { timeout: 20_000 },
    async () => {
      const { orderId, tokenId } = await orderFixture();
      const signature = await file({
        received: "25000000",
        expected: "25000000",
        reason: "war_full",
        createdAt: new Date(),
      });
      const orphanId = await orphanIdFor(signature);
      const session = await createAdminSession("admin", "hashed");

      const response = await discardRoute(
        ...discardRequest(orphanId, "  Refunded 25 USDC to the fee payer.  ", {
          cookie: `${ADMIN_COOKIE}=${session.id}`,
        }),
      );
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ ok: true, discarded: orphanId });

      const [row] = await query<{
        status: string;
        applied_by: string;
        applied_order_id: string | null;
        resolution_note: string;
        resolved_at: Date | null;
      }>(
        `SELECT status, applied_by, applied_order_id, resolution_note, resolved_at
           FROM unmatched_payments WHERE id = $1`,
        [orphanId],
      );
      expect(row.status).toBe("discarded");
      // The same audit answer assignment records, in the same column.
      expect(row.applied_by).toBe("admin");
      expect(row.resolution_note).toBe("Refunded 25 USDC to the fee payer.");
      expect(row.resolved_at).toBeTruthy();
      // Nothing was applied to anything.
      expect(row.applied_order_id).toBeNull();

      // The three tables a discard must never touch.
      expect(await query(`SELECT id FROM payments`)).toHaveLength(0);
      expect(await query(`SELECT status FROM entry_orders WHERE id = $1`, [orderId])).toEqual([
        { status: "pending" },
      ]);
      expect(await query(`SELECT status FROM war_tokens WHERE id = $1`, [tokenId])).toEqual([
        { status: "reserved" },
      ]);
    },
  );

  it("refuses a discard with no note, and changes nothing", { timeout: 20_000 }, async () => {
    const signature = await file({
      received: "25000000",
      expected: "25000000",
      reason: "war_full",
      createdAt: new Date(),
    });
    const orphanId = await orphanIdFor(signature);
    const session = await createAdminSession("admin", "hashed");

    // Whitespace only: the check is on the trimmed value, not on the field
    // being present, or a space would buy an empty audit trail.
    const response = await discardRoute(
      ...discardRequest(orphanId, "   ", { cookie: `${ADMIN_COOKIE}=${session.id}` }),
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ reason: "note_required" });
    expect(await query(`SELECT status FROM unmatched_payments WHERE id = $1`, [orphanId])).toEqual([
      { status: "open" },
    ]);
  });

  it(
    "is idempotent under a double-click, including two that land at once",
    { timeout: 20_000 },
    async () => {
      const signature = await file({
        received: "25000000",
        expected: "25000000",
        reason: "war_full",
        createdAt: new Date(),
      });
      const orphanId = await orphanIdFor(signature);
      const session = await createAdminSession("admin", "hashed");
      const cookie = { cookie: `${ADMIN_COOKIE}=${session.id}` };

      // Genuinely concurrent: both in flight before either commits, which is
      // the case a status check would lose to and the FOR UPDATE lock on the
      // unmatched_payments row is there for.
      const [a, b] = await Promise.all([
        discardRoute(...discardRequest(orphanId, "Refunded.", cookie)),
        discardRoute(...discardRequest(orphanId, "Refunded again.", cookie)),
      ]);
      expect([a.status, b.status].sort()).toEqual([200, 409]);

      const third = await discardRoute(...discardRequest(orphanId, "And again.", cookie));
      expect(third.status).toBe(409);
      expect(await third.json()).toMatchObject({ reason: "already_resolved" });

      // One note, from the one request that won. The losers wrote nothing.
      const [row] = await query<{ status: string; resolution_note: string }>(
        `SELECT status, resolution_note FROM unmatched_payments WHERE id = $1`,
        [orphanId],
      );
      expect(row.status).toBe("discarded");
      expect(["Refunded.", "Refunded again."]).toContain(row.resolution_note);
    },
  );

  it(
    "leaves a discarded payment unassignable by any path",
    { timeout: 20_000 },
    async () => {
      const { orderId, tokenId } = await orderFixture();
      const signature = await file({
        received: "25000000",
        expected: "25000000",
        reason: "war_full",
        createdAt: new Date(),
      });
      const orphanId = await orphanIdFor(signature);
      const session = await createAdminSession("admin", "hashed");
      const cookie = { cookie: `${ADMIN_COOKIE}=${session.id}` };

      expect((await discardRoute(...discardRequest(orphanId, "Refunded.", cookie))).status).toBe(200);

      // Assignment reads the same row under the same lock and acts only on an
      // 'open' one, so a discarded payment cannot be settled afterwards — the
      // two actions are exclusive through one status, not two checks that
      // could drift apart.
      const assigned = await assignRoute(...assignRequest(orphanId, orderId, cookie));
      expect(assigned.status).toBe(409);
      expect(await assigned.json()).toMatchObject({ reason: "already_resolved" });

      expect(await query(`SELECT id FROM payments`)).toHaveLength(0);
      expect(await query(`SELECT status FROM entry_orders WHERE id = $1`, [orderId])).toEqual([
        { status: "pending" },
      ]);
      expect(await query(`SELECT status FROM war_tokens WHERE id = $1`, [tokenId])).toEqual([
        { status: "reserved" },
      ]);
    },
  );

  it("answers a browser with a redirect, not JSON", { timeout: 20_000 }, async () => {
    const signature = await file({
      received: "25000000",
      expected: "25000000",
      reason: "war_full",
      createdAt: new Date(),
    });
    const orphanId = await orphanIdFor(signature);
    const session = await createAdminSession("admin", "hashed");

    const response = await discardRoute(
      ...discardRequest(orphanId, "Refunded.", {
        cookie: `${ADMIN_COOKIE}=${session.id}`,
        accept: "text/html,application/xhtml+xml",
      }),
    );

    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe("/admin/orphans?discarded=1");

    // A browser that submitted an empty note comes back to the list with the
    // reason in the query string, not to a JSON body it cannot render.
    const other = await file({
      received: "25000000",
      expected: "25000000",
      reason: "war_closed",
      createdAt: new Date(),
    });
    const emptyNote = await discardRoute(
      ...discardRequest(await orphanIdFor(other), "", {
        cookie: `${ADMIN_COOKIE}=${session.id}`,
        accept: "text/html",
      }),
    );
    expect(emptyNote.status).toBe(303);
    expect(emptyNote.headers.get("location")).toBe("/admin/orphans?error=note_required");
  });
});

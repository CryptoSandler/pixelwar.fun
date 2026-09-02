import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { queryOne } from "../../../lib/db";
import { makeToken, makeWar } from "../../../lib/canvas/__tests__/fixtures";

/**
 * The admission cap, and the fact that it is no longer the palette's opinion.
 *
 * 24 was never a product decision — it was the size of the palette, back when
 * a token WAS a colour. Migration 007 removed that premise and 008 removed
 * the constraint. What is being pinned down here is that the cap can now hold
 * a number the palette could not have expressed, because that is the whole
 * claim and a CHECK constraint is exactly the kind of thing that silently
 * survives a refactor.
 */

const guard = vi.hoisted(() => ({ ok: true }));
vi.mock("../../../lib/admin-guard", () => ({
  requireAdmin: async () =>
    guard.ok
      ? { ok: true, ipHash: "ip-test" }
      : { ok: false, response: new Response("no", { status: 401 }) },
}));

const { POST: setCap } = await import("../admin/wars/[id]/cap/route");

function post(id: string, body: unknown) {
  return setCap(
    new Request(`https://pixelwar.fun/api/admin/wars/${id}/cap`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ id }) },
  );
}

async function capOf(id: string): Promise<number> {
  const row = await queryOne<{ max_tokens: number }>(`SELECT max_tokens FROM wars WHERE id = $1`, [id]);
  return row!.max_tokens;
}

describe("POST /api/admin/wars/[id]/cap", () => {
  beforeEach(() => {
    guard.ok = true;
  });
  afterEach(() => {
    guard.ok = true;
  });

  it("accepts a cap the palette could never have expressed", { timeout: 20_000 }, async () => {
    const war = await makeWar({ width: 100, height: 100 });

    const response = await post(war.id, { maxTokens: 60 });

    expect(response.status).toBe(200);
    expect(await capOf(war.id)).toBe(60);
  });

  it("refuses a cap past what one byte can name", { timeout: 20_000 }, async () => {
    const war = await makeWar({ width: 100, height: 100 });

    // 255 is the ceiling and it is arithmetic: the territory layer names an
    // owner in one byte and reserves 0 for unpainted.
    expect((await post(war.id, { maxTokens: 256 })).status).toBe(400);
    expect((await post(war.id, { maxTokens: 0 })).status).toBe(400);
    expect((await post(war.id, { maxTokens: 3.5 })).status).toBe(400);
    expect(await capOf(war.id)).toBe(24);
  });

  it("lowers the cap without evicting anybody already seated", { timeout: 20_000 }, async () => {
    const war = await makeWar({ width: 100, height: 100 });
    await makeToken(war.id, 1);
    await makeToken(war.id, 2);
    await makeToken(war.id, 3);

    const response = await post(war.id, { maxTokens: 1 });
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toMatchObject({ maxTokens: 1, seated: 3 });
    // The door is closed; the people inside keep their places. Un-seating a
    // community that has paid is not a thing a settings change may do.
    const still = await queryOne<{ count: string }>(
      `SELECT count(*) AS count FROM war_tokens WHERE war_id = $1 AND status = 'active'`,
      [war.id],
    );
    expect(Number(still!.count)).toBe(3);
  });

  it("404s an unknown war rather than reporting success", { timeout: 20_000 }, async () => {
    const response = await post(randomUUID(), { maxTokens: 10 });
    expect(response.status).toBe(404);
  });

  it("refuses when the admin guard refuses", { timeout: 20_000 }, async () => {
    const war = await makeWar({ width: 100, height: 100 });
    guard.ok = false;

    const response = await post(war.id, { maxTokens: 60 });

    expect(response.status).toBe(401);
    expect(await capOf(war.id)).toBe(24);
  });
});

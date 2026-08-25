import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { execute, query, queryOne } from "../../db";
import type { War } from "../../wars/lifecycle";
import { createOrder, expireStaleOrders, freeColours, orderById } from "../orders";
import type { CreateOrderInput } from "../orders";

/**
 * The specification for colour reservation: the four `war_tokens` statuses
 * and the two races the partial unique indexes from migration 001 decide.
 *
 * `war` here is a local fixture rather than `canvas/__tests__/fixtures.ts`'s
 * `makeWar`, because the `war_full` test needs a war with `max_tokens` lower
 * than the default 24, and that file is Batch A's and off limits.
 */

async function war(
  overrides: Partial<{
    maxTokens: number;
    status: string;
    startsAt: Date;
    endsAt: Date;
  }> = {},
): Promise<War> {
  const id = randomUUID();
  await execute(
    `INSERT INTO wars (id, slug, title, status, width, height, max_tokens,
                        entry_price_usd, cooldown_seconds, starts_at, ends_at)
     VALUES ($1, $1, 'Fixture war', $2, 8, 8, $3, 25, 30, $4, $5)`,
    [
      id,
      overrides.status ?? "live",
      overrides.maxTokens ?? 24,
      overrides.startsAt ?? new Date(Date.now() - 3_600_000),
      overrides.endsAt ?? new Date(Date.now() + 3_600_000),
    ],
  );
  const row = await queryOne<{
    id: string;
    slug: string;
    title: string;
    status: string;
    width: number;
    height: number;
    max_tokens: number;
    entry_price_usd: number;
    cooldown_seconds: number;
    starts_at: Date;
    ends_at: Date;
    last_seq: string;
    ended_at: Date | null;
  }>(`SELECT * FROM wars WHERE id = $1`, [id]);
  return {
    id: row!.id,
    slug: row!.slug,
    title: row!.title,
    status: row!.status as War["status"],
    width: row!.width,
    height: row!.height,
    maxTokens: row!.max_tokens,
    entryPriceUsd: row!.entry_price_usd,
    cooldownSeconds: row!.cooldown_seconds,
    startsAt: row!.starts_at,
    endsAt: row!.ends_at,
    lastSeq: Number(row!.last_seq),
    endedAt: row!.ended_at,
  };
}

/** Inserts a war_tokens row directly, at whatever status a test needs to set up around. */
async function insertToken(overrides: {
  warId: string;
  colourSlot: number;
  status: "reserved" | "active" | "removed" | "released";
  contractKey?: string;
}): Promise<string> {
  const id = randomUUID();
  await execute(
    `INSERT INTO war_tokens
       (id, war_id, chain_id, contract, contract_key, colour_slot, status,
        name, ticker, metadata_fetched_at, reserved_at, joined_at, released_at, released_reason)
     VALUES ($1, $2, 'solana', $1, $3, $4, $5, 'Fixture', 'FIX', now(), now(),
             CASE WHEN $5 IN ('active','removed') THEN now() ELSE NULL END,
             CASE WHEN $5 IN ('removed','released') THEN now() ELSE NULL END,
             CASE WHEN $5 = 'removed' THEN 'pulled_by_operator'
                  WHEN $5 = 'released' THEN 'order_expired' ELSE NULL END)`,
    [id, overrides.warId, overrides.contractKey ?? randomUUID(), overrides.colourSlot, overrides.status],
  );
  return id;
}

function orderInput(overrides: {
  warId: string;
  colourSlot: number;
  contractKey?: string;
  referencePubkey?: string;
  payerPubkey?: string | null;
}): CreateOrderInput {
  return {
    warId: overrides.warId,
    chainId: "solana",
    contract: overrides.contractKey ?? randomUUID(),
    contractKey: overrides.contractKey ?? randomUUID(),
    colourSlot: overrides.colourSlot,
    name: "Fixture Token",
    ticker: "FIX",
    referencePubkey: overrides.referencePubkey ?? randomUUID(),
    payerPubkey: overrides.payerPubkey,
  };
}

describe("createOrder", () => {
  it(
    "reserves a colour and opens an order for it",
    { timeout: 20_000 },
    async () => {
      const w = await war();

      const result = await createOrder(orderInput({ warId: w.id, colourSlot: 5 }));

      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error("expected ok");
      expect(result.order.status).toBe("pending");
      expect(result.order.amountUsd).toBe(w.entryPriceUsd);
      expect(result.order.warId).toBe(w.id);

      const [tokenRow] = await query<{ status: string; colour_slot: number }>(
        `SELECT status, colour_slot FROM war_tokens WHERE id = $1`,
        [result.order.warTokenId],
      );
      expect(tokenRow).toMatchObject({ status: "reserved", colour_slot: 5 });
    },
  );

  it(
    "refuses a colour another live reservation holds",
    { timeout: 20_000 },
    async () => {
      const w = await war();
      const first = await createOrder(orderInput({ warId: w.id, colourSlot: 5 }));
      expect(first.ok).toBe(true);

      const second = await createOrder(orderInput({ warId: w.id, colourSlot: 5 }));

      expect(second).toEqual({ ok: false, reason: "colour_taken" });
    },
  );

  it(
    "refuses a colour an active token holds",
    { timeout: 20_000 },
    async () => {
      const w = await war();
      await insertToken({ warId: w.id, colourSlot: 5, status: "active" });

      const result = await createOrder(orderInput({ warId: w.id, colourSlot: 5 }));

      expect(result).toEqual({ ok: false, reason: "colour_taken" });
    },
  );

  it(
    "refuses a token already entered in this war",
    { timeout: 20_000 },
    async () => {
      const w = await war();
      const contractKey = randomUUID();
      const first = await createOrder(orderInput({ warId: w.id, colourSlot: 5, contractKey }));
      expect(first.ok).toBe(true);

      const second = await createOrder(
        orderInput({ warId: w.id, colourSlot: 6, contractKey }),
      );

      expect(second).toEqual({ ok: false, reason: "already_entered" });
    },
  );

  it(
    "allows the same token in a different war",
    { timeout: 20_000 },
    async () => {
      const warA = await war();
      const warB = await war();
      const contractKey = randomUUID();
      const first = await createOrder(
        orderInput({ warId: warA.id, colourSlot: 5, contractKey }),
      );
      expect(first.ok).toBe(true);

      const second = await createOrder(
        orderInput({ warId: warB.id, colourSlot: 5, contractKey }),
      );

      expect(second.ok).toBe(true);
    },
  );

  it(
    "frees the colour when an unpaid reservation expires",
    { timeout: 20_000 },
    async () => {
      const w = await war();
      const opened = await createOrder(orderInput({ warId: w.id, colourSlot: 5 }));
      expect(opened.ok).toBe(true);
      if (!opened.ok) throw new Error("expected ok");

      await execute(
        `UPDATE entry_orders SET expires_at = now() - interval '1 minute' WHERE id = $1`,
        [opened.order.id],
      );

      const expiredCount = await expireStaleOrders();
      expect(expiredCount).toBe(1);

      const [tokenRow] = await query<{ status: string; released_reason: string | null }>(
        `SELECT status, released_reason FROM war_tokens WHERE id = $1`,
        [opened.order.warTokenId],
      );
      expect(tokenRow.status).toBe("released");
      expect(tokenRow.released_reason).toBeTruthy();

      const refreshedOrder = await orderById(opened.order.id);
      expect(refreshedOrder?.status).toBe("expired");

      // The colour is genuinely free again: a fresh order can take it.
      const retaken = await createOrder(orderInput({ warId: w.id, colourSlot: 5 }));
      expect(retaken.ok).toBe(true);
    },
  );

  it(
    "keeps a removed token's colour retired for the rest of the war",
    { timeout: 20_000 },
    async () => {
      const w = await war();
      await insertToken({ warId: w.id, colourSlot: 5, status: "removed" });

      const result = await createOrder(orderInput({ warId: w.id, colourSlot: 5 }));

      expect(result).toEqual({ ok: false, reason: "colour_taken" });
    },
  );

  it(
    "lets exactly one of two simultaneous orders take a colour",
    { timeout: 20_000 },
    async () => {
      const w = await war();

      const [a, b] = await Promise.all([
        createOrder(orderInput({ warId: w.id, colourSlot: 7 })),
        createOrder(orderInput({ warId: w.id, colourSlot: 7 })),
      ]);

      const outcomes = [a, b];
      const winners = outcomes.filter((r) => r.ok);
      const losers = outcomes.filter((r) => !r.ok);
      expect(winners).toHaveLength(1);
      expect(losers).toHaveLength(1);
      expect(losers[0]).toEqual({ ok: false, reason: "colour_taken" });
    },
  );

  it(
    "lets exactly one of two simultaneous orders take a token",
    { timeout: 20_000 },
    async () => {
      const w = await war();
      const contractKey = randomUUID();

      const [a, b] = await Promise.all([
        createOrder(orderInput({ warId: w.id, colourSlot: 8, contractKey })),
        createOrder(orderInput({ warId: w.id, colourSlot: 9, contractKey })),
      ]);

      const outcomes = [a, b];
      const winners = outcomes.filter((r) => r.ok);
      const losers = outcomes.filter((r) => !r.ok);
      expect(winners).toHaveLength(1);
      expect(losers).toHaveLength(1);
      expect(losers[0]).toEqual({ ok: false, reason: "already_entered" });
    },
  );

  it(
    "refuses once every colour is spoken for",
    { timeout: 20_000 },
    async () => {
      const w = await war({ maxTokens: 1 });
      const first = await createOrder(orderInput({ warId: w.id, colourSlot: 1 }));
      expect(first.ok).toBe(true);

      const second = await createOrder(orderInput({ warId: w.id, colourSlot: 2 }));

      expect(second).toEqual({ ok: false, reason: "war_full" });
    },
  );

  it(
    "refuses an order on a war that has ended",
    { timeout: 20_000 },
    async () => {
      const w = await war({
        status: "ended",
        startsAt: new Date(Date.now() - 7_200_000),
        endsAt: new Date(Date.now() - 3_600_000),
      });

      const result = await createOrder(orderInput({ warId: w.id, colourSlot: 5 }));

      expect(result).toEqual({ ok: false, reason: "war_closed" });
    },
  );

  it(
    "accepts an order while the war is running",
    { timeout: 20_000 },
    async () => {
      const w = await war({ status: "live" });

      const result = await createOrder(orderInput({ warId: w.id, colourSlot: 5 }));

      expect(result.ok).toBe(true);
    },
  );
});

describe("freeColours", () => {
  it(
    "reports every slot not held by a live claim",
    { timeout: 20_000 },
    async () => {
      const w = await war({ maxTokens: 3 });
      await insertToken({ warId: w.id, colourSlot: 1, status: "active" });
      await insertToken({ warId: w.id, colourSlot: 2, status: "removed" });
      await insertToken({ warId: w.id, colourSlot: 3, status: "released" });

      const free = await freeColours(w.id);

      expect(free).toEqual([3]);
    },
  );
});

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
                        entry_price_usd, entry_price_sol, cooldown_seconds, starts_at, ends_at)
     VALUES ($1, $1, 'Fixture war', $2, 8, 8, $3, 25, 25000000, 30, $4, $5)`,
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
    entryPriceLamports: 25_000_000n,
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
  /**
   * IGNORED, and kept in the signature on purpose. Several tests below read
   * better naming the flag they expect ("the order that took slot 5"), and a
   * field that is accepted and dropped says out loud that the caller no
   * longer decides it — which is the change this file exists to describe.
   */
  colourSlot?: number;
  contractKey?: string;
  referencePubkey?: string;
  payerPubkey?: string | null;
}): CreateOrderInput {
  return {
    warId: overrides.warId,
    chainId: "solana",
    contract: overrides.contractKey ?? randomUUID(),
    contractKey: overrides.contractKey ?? randomUUID(),
    name: "Fixture Token",
    ticker: "FIX",
    referencePubkey: overrides.referencePubkey ?? randomUUID(),
    payerPubkey: overrides.payerPubkey,
  };
}

/**
 * Opens a real order and then winds its payment window into the past, so the
 * reservation it holds is dead but nothing has yet noticed. This is the state
 * the whole batch was silently stuck in: `expireStaleOrders` existed, worked,
 * was tested — and nothing ever called it.
 *
 * Deliberately does NOT call the expirer. Every test below that uses this is
 * asserting the WIRING, not the expirer: that the function under test runs it
 * itself. A test that expires by hand first passes just as happily with no
 * caller anywhere, which is exactly how this defect survived review.
 */
async function deadReservation(warId: string, colourSlot?: number): Promise<string> {
  const opened = await createOrder(orderInput({ warId, colourSlot }));
  if (!opened.ok) throw new Error(`expected an order, got ${opened.reason}`);
  await execute(
    `UPDATE entry_orders SET expires_at = now() - interval '1 minute' WHERE id = $1`,
    [opened.order.id],
  );
  return opened.order.id;
}

describe("createOrder", () => {
  it(
    "takes a seat, opens an order, and prices it in lamports",
    { timeout: 20_000 },
    async () => {
      const w = await war();

      const result = await createOrder(orderInput({ warId: w.id }));

      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error("expected ok");
      expect(result.order.status).toBe("pending");
      expect(result.order.amountLamports).toBe(w.entryPriceLamports);
      expect(result.order.warId).toBe(w.id);

      const [tokenRow] = await query<{ status: string; colour_slot: number }>(
        `SELECT status, colour_slot FROM war_tokens WHERE id = $1`,
        [result.order.warTokenId],
      );
      // The FIRST free slot, assigned rather than asked for.
      expect(tokenRow).toMatchObject({ status: "reserved", colour_slot: 1 });
    },
  );

  it(
    "records no dollar price at all, rather than a filler one",
    { timeout: 20_000 },
    async () => {
      // Migration 016. A 1 in a money column is indistinguishable from a real
      // price to anybody who sums it later; NULL says "never priced in
      // dollars", which is the truth about every order since admission moved
      // to SOL.
      const w = await war();
      const result = await createOrder(orderInput({ warId: w.id }));
      if (!result.ok) throw new Error(`expected ok, got ${result.reason}`);

      const [row] = await query<{ amount_usd: number | null; amount_lamports: string | null }>(
        `SELECT amount_usd, amount_lamports FROM entry_orders WHERE id = $1`,
        [result.order.id],
      );

      expect(row.amount_usd).toBeNull();
      // And the column that DOES price it is populated, so this is not just
      // an order with no price at all.
      expect(row.amount_lamports).toBe("25000000");
      expect(result.order.amountUsd).toBeNull();
      expect(result.order.amountLamports).toBe(25_000_000n);
    },
  );

  it(
    "leaves a real dollar price alone where one was genuinely charged",
    { timeout: 20_000 },
    async () => {
      // The other half of migration 016, and the reason it did not backfill:
      // an order written before the change was really asked for that many
      // dollars, and NULLing it would destroy the only record of it.
      const w = await war();
      const result = await createOrder(orderInput({ warId: w.id }));
      if (!result.ok) throw new Error("expected ok");
      await execute(`UPDATE entry_orders SET amount_usd = 25 WHERE id = $1`, [result.order.id]);

      const reread = await orderById(result.order.id);
      expect(reread?.amountUsd).toBe(25);
    },
  );

  it(
    "hands out the lowest free flag, in order, without anybody choosing",
    { timeout: 20_000 },
    async () => {
      const w = await war();

      const slots: number[] = [];
      for (let i = 0; i < 3; i++) {
        const result = await createOrder(orderInput({ warId: w.id }));
        if (!result.ok) throw new Error(`order ${i} failed: ${result.reason}`);
        const [row] = await query<{ colour_slot: number }>(
          `SELECT colour_slot FROM war_tokens WHERE id = $1`,
          [result.order.warTokenId],
        );
        slots.push(row.colour_slot);
      }

      expect(slots).toEqual([1, 2, 3]);
    },
  );

  it(
    "steps over a flag an active token already holds",
    { timeout: 20_000 },
    async () => {
      // The assignment reads the same "not released" predicate capacity does,
      // so a seat taken by any live token — reserved, active or removed — is
      // a number the next entrant does not get.
      const w = await war();
      await insertToken({ warId: w.id, colourSlot: 1, status: "active" });
      await insertToken({ warId: w.id, colourSlot: 2, status: "removed" });

      const result = await createOrder(orderInput({ warId: w.id }));
      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error("expected ok");

      const [row] = await query<{ colour_slot: number }>(
        `SELECT colour_slot FROM war_tokens WHERE id = $1`,
        [result.order.warTokenId],
      );
      expect(row.colour_slot).toBe(3);
    },
  );

  it(
    "reuses a flag whose reservation was released",
    { timeout: 20_000 },
    async () => {
      // A released row does not hold its number: that is what makes an
      // expired order give the seat back rather than burning it.
      const w = await war();
      await insertToken({ warId: w.id, colourSlot: 1, status: "released" });

      const result = await createOrder(orderInput({ warId: w.id }));
      if (!result.ok) throw new Error("expected ok");
      const [row] = await query<{ colour_slot: number }>(
        `SELECT colour_slot FROM war_tokens WHERE id = $1`,
        [result.order.warTokenId],
      );
      expect(row.colour_slot).toBe(1);
    },
  );

  it(
    "refuses to price an order against a war with no SOL price",
    { timeout: 20_000 },
    async () => {
      // Migration 015 left the column nullable so a war that predates SOL
      // pricing is visible rather than silently charged zero.
      const w = await war();
      await execute(`UPDATE wars SET entry_price_sol = NULL WHERE id = $1`, [w.id]);

      expect(await createOrder(orderInput({ warId: w.id }))).toEqual({
        ok: false,
        reason: "no_price",
      });
    },
  );

  it(
    "refuses a token already entered in this war",
    { timeout: 20_000 },
    async () => {
      const w = await war();
      const contractKey = randomUUID();
      const first = await createOrder(orderInput({ warId: w.id, contractKey }));
      expect(first.ok).toBe(true);

      const second = await createOrder(orderInput({ warId: w.id, contractKey }));

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
      const first = await createOrder(orderInput({ warId: warA.id, contractKey }));
      expect(first.ok).toBe(true);

      const second = await createOrder(orderInput({ warId: warB.id, contractKey }));

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
    "keeps a removed token's flag retired for the rest of the war",
    { timeout: 20_000 },
    async () => {
      // A 'removed' token is moderation's doing, and its seat does not come
      // back — so the number is stepped over rather than reissued. That is
      // now visible in what the NEXT entrant is handed rather than in a
      // refusal, because nobody asks for a number any more.
      const w = await war();
      await insertToken({ warId: w.id, colourSlot: 1, status: "removed" });

      const result = await createOrder(orderInput({ warId: w.id }));
      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error("expected ok");

      const [row] = await query<{ colour_slot: number }>(
        `SELECT colour_slot FROM war_tokens WHERE id = $1`,
        [result.order.warTokenId],
      );
      expect(row.colour_slot).toBe(2);
    },
  );

  it(
    "gives two simultaneous orders two different flags",
    { timeout: 20_000 },
    async () => {
      // The race that used to produce a loser now produces two winners with
      // different numbers: the war row's FOR UPDATE serialises assignment, so
      // the second caller reads the first one's slot as taken. If that lock
      // were removed, both would compute 1 and the partial unique index would
      // refuse one of them — which is why this asserts BOTH succeeded, not
      // merely that they differ.
      const w = await war();

      const [a, b] = await Promise.all([
        createOrder(orderInput({ warId: w.id })),
        createOrder(orderInput({ warId: w.id })),
      ]);

      expect(a.ok && b.ok).toBe(true);
      if (!a.ok || !b.ok) throw new Error("expected both to succeed");

      const rows = await query<{ colour_slot: number }>(
        `SELECT colour_slot FROM war_tokens WHERE id = ANY($1::text[]) ORDER BY colour_slot`,
        [[a.order.warTokenId, b.order.warTokenId]],
      );
      expect(rows.map((r) => r.colour_slot)).toEqual([1, 2]);
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
    "seats no more than max_tokens when two orders race the last seat",
    { timeout: 20_000 },
    async () => {
      // Fix round 1: without locking the war row for the length of the
      // transaction, two concurrent createOrder calls for two DIFFERENT
      // colours each read the same pre-race count under READ COMMITTED and
      // both pass the capacity check — no unique index arbitrates capacity
      // the way one arbitrates colour or contract. This reproduced 4 times
      // in 5 before the FOR UPDATE fix, so the race is run several times
      // here rather than once, against a fresh war each time.
      for (let attempt = 0; attempt < 5; attempt++) {
        const w = await war({ maxTokens: 1 });

        const [a, b] = await Promise.all([
          createOrder(orderInput({ warId: w.id, colourSlot: 1 })),
          createOrder(orderInput({ warId: w.id, colourSlot: 2 })),
        ]);

        const outcomes = [a, b];
        const winners = outcomes.filter((r) => r.ok);
        const losers = outcomes.filter((r) => !r.ok);
        expect(winners).toHaveLength(1);
        expect(losers).toHaveLength(1);
        expect(losers[0]).toEqual({ ok: false, reason: "war_full" });

        const seated = await query<{ id: string }>(
          `SELECT id FROM war_tokens WHERE war_id = $1 AND status <> 'released'`,
          [w.id],
        );
        expect(seated).toHaveLength(1);
      }
    },
  );

  it(
    "reports war_full rather than colour_taken when both are true",
    { timeout: 20_000 },
    async () => {
      // Pins the priority: when a war is already full AND the specific
      // colour requested is also separately taken, war_full wins — the
      // capacity check short-circuits before the insert (and its unique
      // indexes) is ever attempted.
      const w = await war({ maxTokens: 1 });
      const first = await createOrder(orderInput({ warId: w.id, colourSlot: 1 }));
      expect(first.ok).toBe(true);

      const second = await createOrder(orderInput({ warId: w.id, colourSlot: 1 }));

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
    "refuses an order on a war that is still a draft",
    { timeout: 20_000 },
    async () => {
      const w = await war({
        status: "draft",
        startsAt: new Date(Date.now() + 3_600_000),
        endsAt: new Date(Date.now() + 7_200_000),
      });

      const result = await createOrder(orderInput({ warId: w.id, colourSlot: 5 }));

      expect(result).toEqual({ ok: false, reason: "war_closed" });
    },
  );

  it(
    "accepts an order on a scheduled war",
    { timeout: 20_000 },
    async () => {
      const w = await war({
        status: "scheduled",
        startsAt: new Date(Date.now() + 3_600_000),
        endsAt: new Date(Date.now() + 7_200_000),
      });

      const result = await createOrder(orderInput({ warId: w.id, colourSlot: 5 }));

      expect(result.ok).toBe(true);
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

  it(
    "expires a dead reservation itself, so a payer is never refused its colour",
    { timeout: 20_000 },
    async () => {
      const w = await war();
      const abandoned = await deadReservation(w.id, 5);

      // Nobody calls expireStaleOrders here. If createOrder does not run it,
      // the partial unique index does its job on a reservation that has no
      // claim left and this comes back `colour_taken`.
      const result = await createOrder(orderInput({ warId: w.id, colourSlot: 5 }));

      expect(result.ok).toBe(true);

      const stale = await orderById(abandoned);
      expect(stale?.status).toBe("expired");
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

  it(
    "releases a colour whose reservation expired, with no help from the caller",
    { timeout: 20_000 },
    async () => {
      const w = await war({ maxTokens: 3 });
      await insertToken({ warId: w.id, colourSlot: 1, status: "active" });
      const abandoned = await deadReservation(w.id, 2);

      // Again: no hand-rolled expiry. Slot 2 comes back only if freeColours
      // expired the dead reservation on its own.
      const free = await freeColours(w.id);

      expect(free).toEqual([2, 3]);

      const stale = await orderById(abandoned);
      expect(stale?.status).toBe("expired");
      const [tokenRow] = await query<{ status: string; released_reason: string | null }>(
        `SELECT status, released_reason FROM war_tokens WHERE id = (
           SELECT war_token_id FROM entry_orders WHERE id = $1
         )`,
        [abandoned],
      );
      expect(tokenRow.status).toBe("released");
      expect(tokenRow.released_reason).toBe("order_expired");
    },
  );
});

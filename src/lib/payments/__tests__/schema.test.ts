import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { execute, isUniqueViolation, query, violatedConstraint } from "../../db";
import { makeToken, makeWar } from "../../canvas/__tests__/fixtures";

/**
 * Proves the constraints migration 002 declares by violating each one. Every
 * guarantee this schema makes about money — one payment per signature, one
 * payment per order, one order per token, one order per reference — is a
 * constraint here, and a test that only inserts a valid row would not prove
 * any of them hold under a concurrent, adversarial second attempt.
 */

async function makeOrder(overrides: {
  warId: string;
  warTokenId: string;
  referencePubkey?: string;
  amountUsd?: number;
  status?: string;
}): Promise<string> {
  const id = randomUUID();
  await execute(
    `INSERT INTO entry_orders
       (id, war_id, war_token_id, amount_usd, reference_pubkey, status, created_at, expires_at)
     VALUES ($1, $2, $3, $4, $5, $6, now(), now() + interval '30 minutes')`,
    [
      id,
      overrides.warId,
      overrides.warTokenId,
      overrides.amountUsd ?? 25,
      overrides.referencePubkey ?? randomUUID(),
      overrides.status ?? "pending",
    ],
  );
  return id;
}

async function makePayment(overrides: {
  orderId: string;
  signature?: string;
  amountBaseUnits?: string;
}): Promise<string> {
  const id = randomUUID();
  await execute(
    `INSERT INTO payments (id, signature, order_id, amount_base_units, verified_at)
     VALUES ($1, $2, $3, $4, now())`,
    [id, overrides.signature ?? randomUUID(), overrides.orderId, overrides.amountBaseUnits ?? "25000000"],
  );
  return id;
}

async function fixtureOrder(): Promise<{ warId: string; tokenId: string; orderId: string }> {
  const war = await makeWar();
  const tokenId = await makeToken(war.id, 5);
  const orderId = await makeOrder({ warId: war.id, warTokenId: tokenId });
  return { warId: war.id, tokenId, orderId };
}

describe("entry_orders", () => {
  it("creates an order for a reserved token and reads it back", { timeout: 20_000 }, async () => {
    const war = await makeWar();
    const tokenId = await makeToken(war.id, 5);

    const orderId = await makeOrder({ warId: war.id, warTokenId: tokenId });

    const [row] = await query<{ status: string; amount_usd: number; reference_pubkey: string }>(
      `SELECT status, amount_usd, reference_pubkey FROM entry_orders WHERE id = $1`,
      [orderId],
    );
    expect(row).toMatchObject({ status: "pending", amount_usd: 25 });
    expect(row.reference_pubkey).toBeTruthy();
  });

  it("refuses an order referencing a missing war token", { timeout: 20_000 }, async () => {
    const war = await makeWar();

    const attempt = makeOrder({ warId: war.id, warTokenId: randomUUID() });

    await expect(attempt).rejects.toThrow();
  });

  it("refuses an order referencing a missing war", { timeout: 20_000 }, async () => {
    const war = await makeWar();
    const tokenId = await makeToken(war.id, 5);

    const attempt = makeOrder({ warId: randomUUID(), warTokenId: tokenId });

    await expect(attempt).rejects.toThrow();
  });

  it(
    "refuses a second order for the same token: one order per token",
    { timeout: 20_000 },
    async () => {
      const war = await makeWar();
      const tokenId = await makeToken(war.id, 5);
      await makeOrder({ warId: war.id, warTokenId: tokenId });

      const error: unknown = await makeOrder({ warId: war.id, warTokenId: tokenId }).catch(
        (e) => e,
      );

      expect(isUniqueViolation(error)).toBe(true);
      expect(violatedConstraint(error)).toBe("entry_orders_token_unique");
    },
  );

  it(
    "refuses two orders sharing a reference pubkey",
    { timeout: 20_000 },
    async () => {
      const war = await makeWar();
      const tokenA = await makeToken(war.id, 5);
      const tokenB = await makeToken(war.id, 6);
      const reference = randomUUID();
      await makeOrder({ warId: war.id, warTokenId: tokenA, referencePubkey: reference });

      const error: unknown = await makeOrder({
        warId: war.id,
        warTokenId: tokenB,
        referencePubkey: reference,
      }).catch((e) => e);

      expect(isUniqueViolation(error)).toBe(true);
      expect(violatedConstraint(error)).toBe("entry_orders_reference_pubkey_key");
    },
  );

  it("rejects a non-positive price snapshot", { timeout: 20_000 }, async () => {
    const war = await makeWar();
    const tokenId = await makeToken(war.id, 5);

    const attempt = makeOrder({ warId: war.id, warTokenId: tokenId, amountUsd: 0 });

    await expect(attempt).rejects.toThrow();
  });

  it("rejects a status outside the known set", { timeout: 20_000 }, async () => {
    const war = await makeWar();
    const tokenId = await makeToken(war.id, 5);

    const attempt = makeOrder({ warId: war.id, warTokenId: tokenId, status: "refunded" });

    await expect(attempt).rejects.toThrow();
  });
});

describe("payments", () => {
  it(
    "refuses two payments with the same signature: a signature is single-use globally",
    { timeout: 20_000 },
    async () => {
      const war = await makeWar();
      const tokenA = await makeToken(war.id, 5);
      const tokenB = await makeToken(war.id, 6);
      const orderA = await makeOrder({ warId: war.id, warTokenId: tokenA });
      const orderB = await makeOrder({ warId: war.id, warTokenId: tokenB });
      const signature = randomUUID();
      await makePayment({ orderId: orderA, signature });

      const error: unknown = await makePayment({ orderId: orderB, signature }).catch((e) => e);

      expect(isUniqueViolation(error)).toBe(true);
      expect(violatedConstraint(error)).toBe("payments_signature_key");
    },
  );

  it(
    "refuses two payments for the same order: one payment per order",
    { timeout: 20_000 },
    async () => {
      const { orderId } = await fixtureOrder();
      await makePayment({ orderId });

      const error: unknown = await makePayment({ orderId }).catch((e) => e);

      expect(isUniqueViolation(error)).toBe(true);
      expect(violatedConstraint(error)).toBe("payments_order_unique");
    },
  );

  it("refuses a payment for an order that does not exist", { timeout: 20_000 }, async () => {
    const attempt = makePayment({ orderId: randomUUID() });

    await expect(attempt).rejects.toThrow();
  });

  it(
    "stores amount_base_units at full u64 precision, not as a coerced number",
    { timeout: 20_000 },
    async () => {
      const { orderId } = await fixtureOrder();
      // u64 max: far past Number.MAX_SAFE_INTEGER. A NUMERIC or FLOAT column,
      // or any code path that round-tripped this through a JS number, would
      // corrupt it silently.
      const u64Max = "18446744073709551615";

      const paymentId = await makePayment({ orderId, amountBaseUnits: u64Max });

      const [row] = await query<{ amount_base_units: string }>(
        `SELECT amount_base_units FROM payments WHERE id = $1`,
        [paymentId],
      );
      expect(row.amount_base_units).toBe(u64Max);
    },
  );
});

describe("consumed_signatures", () => {
  it("refuses the same signature offered twice", { timeout: 20_000 }, async () => {
    const signature = randomUUID();
    await execute(
      `INSERT INTO consumed_signatures (signature, outcome, consumed_at) VALUES ($1, 'verified', now())`,
      [signature],
    );

    const attempt = execute(
      `INSERT INTO consumed_signatures (signature, outcome, consumed_at) VALUES ($1, 'stale', now())`,
      [signature],
    );

    await expect(attempt).rejects.toThrow();
  });

  it(
    "accepts a signature with no matching order, for the paste-a-signature fallback",
    { timeout: 20_000 },
    async () => {
      const signature = randomUUID();

      await execute(
        `INSERT INTO consumed_signatures (signature, order_id, outcome, consumed_at)
         VALUES ($1, NULL, 'unmatched', now())`,
        [signature],
      );

      const [row] = await query<{ order_id: string | null }>(
        `SELECT order_id FROM consumed_signatures WHERE signature = $1`,
        [signature],
      );
      expect(row.order_id).toBeNull();
    },
  );
});

describe("unmatched_payments", () => {
  it("refuses two unmatched rows for the same signature", { timeout: 20_000 }, async () => {
    const signature = randomUUID();
    await execute(
      `INSERT INTO unmatched_payments
         (id, signature, received_base_units, expected_base_units, reason, created_at)
       VALUES ($1, $2, '25000000', '25000000', 'no matching order', now())`,
      [randomUUID(), signature],
    );

    const attempt = execute(
      `INSERT INTO unmatched_payments
         (id, signature, received_base_units, expected_base_units, reason, created_at)
       VALUES ($1, $2, '25000000', '25000000', 'no matching order', now())`,
      [randomUUID(), signature],
    );

    await expect(attempt).rejects.toThrow();
  });

  it("rejects a status outside the known set", { timeout: 20_000 }, async () => {
    const attempt = execute(
      `INSERT INTO unmatched_payments
         (id, signature, received_base_units, expected_base_units, reason, status, created_at)
       VALUES ($1, $2, '25000000', '25000000', 'no matching order', 'refunded', now())`,
      [randomUUID(), randomUUID()],
    );

    await expect(attempt).rejects.toThrow();
  });

  it("defaults to an open status and an empty sender_debited array", { timeout: 20_000 }, async () => {
    const id = randomUUID();
    await execute(
      `INSERT INTO unmatched_payments
         (id, signature, received_base_units, expected_base_units, reason, created_at)
       VALUES ($1, $2, '25000000', '25000000', 'no matching order', now())`,
      [id, randomUUID()],
    );

    const [row] = await query<{ status: string; sender_debited: unknown[] }>(
      `SELECT status, sender_debited FROM unmatched_payments WHERE id = $1`,
      [id],
    );
    expect(row.status).toBe("open");
    expect(row.sender_debited).toEqual([]);
  });
});

describe("verification_attempts", () => {
  it("records an attempt against an order", { timeout: 20_000 }, async () => {
    const { orderId } = await fixtureOrder();

    await execute(
      `INSERT INTO verification_attempts (id, order_id, ip_hash, attempted_at)
       VALUES ($1, $2, 'ip-a', now())`,
      [randomUUID(), orderId],
    );

    const rows = await query(`SELECT 1 FROM verification_attempts WHERE order_id = $1`, [
      orderId,
    ]);
    expect(rows).toHaveLength(1);
  });

  it("rejects an attempt with no order id", { timeout: 20_000 }, async () => {
    const attempt = execute(
      `INSERT INTO verification_attempts (id, order_id, ip_hash, attempted_at)
       VALUES ($1, NULL, 'ip-a', now())`,
      [randomUUID()],
    );

    await expect(attempt).rejects.toThrow();
  });
});

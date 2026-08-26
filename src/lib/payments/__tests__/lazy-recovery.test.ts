import { randomBytes, randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { base58Encode } from "../../base58";
import { execute } from "../../db";
import { USDC_MINT } from "../config";
import { claimForRecovery, reconcileOnRead } from "../lazy-recovery";
import { orderById, type Order } from "../orders";
import type { RecoveryFetcher } from "../recover";
import type { SolanaTransaction } from "../solana";

/**
 * Reconciliation that does not wait for a scheduler.
 *
 * WHAT THIS FILE IS DEFENDING. The measured failure was not a bug in the
 * recovery pass — that pass works, and `recover.test.ts` proves it. The bug
 * was that firing it was somebody else's job: GitHub Actions delivered runs
 * 2h29m apart against a five-minute schedule, and a ten-minute grace window
 * cannot survive that. So these tests are deliberately NOT about whether
 * recovery finds a payment. They are about whether a payment gets found
 * WITHOUT anything external having to be punctual.
 *
 * Every test here fails if the trigger moves back off the request path.
 */

const PAYMENT_WALLET = "7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU";

function randomSignature(): string {
  return base58Encode(new Uint8Array(randomBytes(64)));
}

async function war(): Promise<string> {
  const id = randomUUID();
  await execute(
    `INSERT INTO wars (id, slug, title, status, width, height, max_tokens,
                       entry_price_usd, cooldown_seconds, starts_at, ends_at)
     VALUES ($1, $1, 'Fixture war', 'live', 8, 8, 24, 25, 30, $2, $3)`,
    [id, new Date(Date.now() - 3_600_000), new Date(Date.now() + 3_600_000)],
  );
  return id;
}

/**
 * A token in the state its order implies.
 *
 * `released` is the default because these tests mostly start from an ALREADY
 * expired order, and expiry is one transaction that moves both rows: the
 * order to `expired` and its token to `released` (see `expireStaleOrders`).
 * A fixture that expires the order but leaves the token `reserved` describes
 * a state the product cannot produce, and `settlePayment` correctly refuses
 * it as `unmatched` — the colour still looks claimed by somebody. That cost
 * a debugging round; it is written down here so it does not cost another.
 */
async function insertToken(
  warId: string,
  colourSlot: number,
  status: "reserved" | "released" = "released",
): Promise<string> {
  const id = randomUUID();
  await execute(
    `INSERT INTO war_tokens
       (id, war_id, chain_id, contract, contract_key, colour_slot, status,
        name, ticker, metadata_fetched_at, reserved_at, released_at, released_reason)
     VALUES ($1, $2, 'solana', $1, $3, $4, $5, 'Fixture', 'FIX', now(), now(),
             CASE WHEN $5 = 'released' THEN now() ELSE NULL END,
             CASE WHEN $5 = 'released' THEN 'order_expired' ELSE NULL END)`,
    [id, warId, randomUUID(), colourSlot, status],
  );
  return id;
}

/**
 * An order in whatever state a test needs.
 *
 * `status` matters more here than in `recover.test.ts`: half of what this
 * file tests is the transition from a `pending` order that is past its own
 * window into an `expired` one recovery can act on, which is the step that
 * makes the whole lazy path reachable.
 */
async function order(overrides: {
  warId: string;
  warTokenId: string;
  status?: "pending" | "expired" | "paid";
  referencePubkey?: string;
  amountUsd?: number;
  expiresInMinutes?: number;
  recoveryAttemptedAt?: Date | null;
}): Promise<Order> {
  const id = randomUUID();
  const expiresInMinutes = overrides.expiresInMinutes ?? -2;
  await execute(
    `INSERT INTO entry_orders
       (id, war_id, war_token_id, amount_usd, payer_pubkey, reference_pubkey, status,
        created_at, expires_at, recovery_attempted_at)
     VALUES ($1, $2, $3, $4, NULL, $5, $6, $7, $8, $9)`,
    [
      id,
      overrides.warId,
      overrides.warTokenId,
      overrides.amountUsd ?? 25,
      overrides.referencePubkey ?? randomUUID(),
      overrides.status ?? "expired",
      new Date(Date.now() - 60 * 60_000),
      new Date(Date.now() + expiresInMinutes * 60_000),
      overrides.recoveryAttemptedAt ?? null,
    ],
  );
  return (await orderById(id))!;
}

function fixtureTransaction(amount: string): SolanaTransaction {
  const payer = "SomeRandomPayerAddress1111111111111111111111";
  return {
    slot: 1,
    blockTime: Math.floor((Date.now() - 30 * 60_000) / 1000),
    transaction: { message: { accountKeys: [{ pubkey: payer, signer: true }] } },
    meta: {
      err: null,
      preTokenBalances: [
        { accountIndex: 0, owner: PAYMENT_WALLET, mint: USDC_MINT, uiTokenAmount: { amount: "0" } },
        { accountIndex: 1, owner: payer, mint: USDC_MINT, uiTokenAmount: { amount: "500000000" } },
      ],
      postTokenBalances: [
        { accountIndex: 0, owner: PAYMENT_WALLET, mint: USDC_MINT, uiTokenAmount: { amount } },
        {
          accountIndex: 1,
          owner: payer,
          mint: USDC_MINT,
          uiTokenAmount: { amount: (500_000_000n - BigInt(amount)).toString() },
        },
      ],
    },
  };
}

/** A chain that credits this order's reference with exactly what it asked for. */
function payingFetcher(
  reference: string,
  signature: string,
  amount = "25000000",
  delayMs = 0,
): RecoveryFetcher {
  return {
    signatures: async (ref) => {
      if (delayMs) await new Promise((r) => setTimeout(r, delayMs));
      return ref === reference ? [{ signature, blockTime: Math.floor(Date.now() / 1000) - 1800 }] : [];
    },
    transaction: async () => fixtureTransaction(amount),
  };
}

describe("claimForRecovery", () => {
  let warId: string;
  beforeEach(async () => {
    warId = await war();
    process.env.PAYMENT_WALLET = PAYMENT_WALLET;
  });

  it("lets exactly one of many concurrent callers through", { timeout: 20_000 }, async () => {
    const tokenId = await insertToken(warId, 1);
    const target = await order({ warId, warTokenId: tokenId });

    // Ten callers, one order, all at once — the shape two browser tabs and a
    // sweep landing together actually produce.
    const results = await Promise.all(
      Array.from({ length: 10 }, () => claimForRecovery(target.id)),
    );

    expect(results.filter(Boolean)).toHaveLength(1);
  });

  it("refuses a second claim inside the cooldown", { timeout: 20_000 }, async () => {
    const tokenId = await insertToken(warId, 2);
    const target = await order({ warId, warTokenId: tokenId });

    expect(await claimForRecovery(target.id, 60)).toBe(true);
    expect(await claimForRecovery(target.id, 60)).toBe(false);
  });

  it("allows another claim once the cooldown has passed", { timeout: 20_000 }, async () => {
    const tokenId = await insertToken(warId, 3);
    const target = await order({
      warId,
      warTokenId: tokenId,
      recoveryAttemptedAt: new Date(Date.now() - 120_000),
    });

    expect(await claimForRecovery(target.id, 60)).toBe(true);
  });

  it("refuses an order that is not expired", { timeout: 20_000 }, async () => {
    const tokenId = await insertToken(warId, 4, "reserved");
    const target = await order({ warId, warTokenId: tokenId, status: "pending", expiresInMinutes: 10 });

    expect(await claimForRecovery(target.id)).toBe(false);
  });
});

describe("reconcileOnRead", () => {
  let warId: string;
  beforeEach(async () => {
    warId = await war();
    process.env.PAYMENT_WALLET = PAYMENT_WALLET;
  });

  it("recovers this order's payment with no scheduler involved", { timeout: 20_000 }, async () => {
    const tokenId = await insertToken(warId, 5);
    const reference = randomUUID();
    const target = await order({ warId, warTokenId: tokenId, referencePubkey: reference });
    const signature = randomSignature();

    const outcome = await reconcileOnRead(target, payingFetcher(reference, signature));

    expect(outcome).toMatchObject({ ran: true, recovered: true });
    expect((await orderById(target.id))!.status).toBe("paid");
  });

  it(
    "expires an order that is past its window before recovering it",
    { timeout: 20_000 },
    async () => {
      // THE REACHABILITY TEST. Recovery only ever considers `status =
      // 'expired'`, and nothing sets that except `expireStaleOrders`, whose
      // other callers run when somebody ELSE is browsing. A payer returning
      // to a dead tab is exactly the case where nobody else is. Without the
      // expire step, this order stays `pending` forever and the lazy path is
      // wired up and unreachable — which is the failure the whole batch is
      // about, reintroduced one layer down.
      const tokenId = await insertToken(warId, 6, "reserved");
      const reference = randomUUID();
      const target = await order({
        warId,
        warTokenId: tokenId,
        status: "pending",
        expiresInMinutes: -5,
        referencePubkey: reference,
      });
      expect(target.status).toBe("pending");

      const outcome = await reconcileOnRead(target, payingFetcher(reference, randomSignature()));

      expect(outcome.ran).toBe(true);
      expect((await orderById(target.id))!.status).toBe("paid");
    },
  );

  it("declines an order still inside its payment window", { timeout: 20_000 }, async () => {
    const tokenId = await insertToken(warId, 7, "reserved");
    const target = await order({ warId, warTokenId: tokenId, status: "pending", expiresInMinutes: 10 });
    const signatures = vi.fn(async () => []);

    const outcome = await reconcileOnRead(target, { signatures });

    expect(outcome.ran).toBe(false);
    // A live order belongs to /confirm. Spending an RPC call on it would be
    // the request path paying for work the request path is not for.
    expect(signatures).not.toHaveBeenCalled();
  });

  it("spends no RPC calls on the second of two concurrent reads", { timeout: 20_000 }, async () => {
    const tokenId = await insertToken(warId, 8);
    const reference = randomUUID();
    const target = await order({ warId, warTokenId: tokenId, referencePubkey: reference });

    let calls = 0;
    const fetcher: RecoveryFetcher = {
      signatures: async () => {
        calls++;
        await new Promise((r) => setTimeout(r, 50));
        return [];
      },
    };

    const [a, b] = await Promise.all([
      reconcileOnRead(target, fetcher),
      reconcileOnRead(target, fetcher),
    ]);

    expect([a.ran, b.ran].filter(Boolean)).toHaveLength(1);
    expect(calls).toBe(1);
  });
});

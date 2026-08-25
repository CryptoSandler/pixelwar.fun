import { describe, expect, it } from "vitest";
import { BLOCKTIME_SKEW_SECONDS, USDC_MINT } from "../config";
import { verifyPayment, type SolanaTransaction } from "../solana";

const WALLET = "8vQ2mQ6xkYPfJ7BFhCGDVzWJ1uYTLDXQoK4Vn5wCq3Rt";
const PAYER = "3nB8sQ1xkYPfJ7BFhCGDVzWJ1uYTLDXQoK4Vn5wCq3Rt";
const OTHER_PAYER = "9zC4wR2xkYPfJ7BFhCGDVzWJ1uYTLDXQoK4Vn5wCq3Rt";
const RELAYER = "6mF1tQ8xkYPfJ7BFhCGDVzWJ1uYTLDXQoK4Vn5wCq3Rt";
const OTHER_MINT = "So11111111111111111111111111111111111111112";

// 64 bytes of base58 — the shape of a real Solana signature.
const SIG = "5".repeat(87);

// An order window the fixtures sit inside, so the time check is not the
// subject of tests that are not about it.
const WINDOW_START = Date.now() - 5 * 60_000;
const WINDOW_END = WINDOW_START + 30 * 60_000;
const INSIDE = Math.floor((WINDOW_START + 60_000) / 1000);

/**
 * Builds a fixture transaction whose token balance deltas say what a test
 * wants. `before`/`after` are the *absolute* balance of our own wallet, pre-
 * and post-transaction — matching how `getTransaction` actually reports them.
 *
 * `feePayer` names the transaction's first signer. Passing `payer` (plus its
 * own before/after) adds a second USDC account, distinct from our wallet's,
 * whose balance drops — the "who actually funded this" signal the payer
 * check reads.
 */
function tx(options: {
  err?: unknown;
  owner?: string;
  mint?: string;
  before?: string;
  after?: string;
  noMeta?: boolean;
  blockTime?: number | null;
  feePayer?: string;
  payer?: string;
  payerBefore?: string;
  payerAfter?: string;
}): SolanaTransaction {
  const owner = options.owner ?? WALLET;
  const mint = options.mint ?? USDC_MINT;
  const feePayer = options.feePayer ?? PAYER;

  const preTokenBalances = [
    { accountIndex: 0, owner, mint, uiTokenAmount: { amount: options.before ?? "0" } },
  ];
  const postTokenBalances = [
    { accountIndex: 0, owner, mint, uiTokenAmount: { amount: options.after ?? "0" } },
  ];

  if (options.payer) {
    preTokenBalances.push({
      accountIndex: 1,
      owner: options.payer,
      mint: USDC_MINT,
      uiTokenAmount: { amount: options.payerBefore ?? "0" },
    });
    postTokenBalances.push({
      accountIndex: 1,
      owner: options.payer,
      mint: USDC_MINT,
      uiTokenAmount: { amount: options.payerAfter ?? "0" },
    });
  }

  const blockTime = options.blockTime === undefined ? INSIDE : options.blockTime;

  if (options.noMeta) {
    return {
      slot: 1,
      blockTime,
      transaction: { message: { accountKeys: [{ pubkey: feePayer, signer: true }] } },
      meta: null,
    };
  }

  return {
    slot: 1,
    blockTime,
    transaction: { message: { accountKeys: [{ pubkey: feePayer, signer: true }] } },
    meta: { err: options.err ?? null, preTokenBalances, postTokenBalances },
  };
}

async function check(
  transaction: SolanaTransaction,
  overrides: { amountUsd?: number; expectedPayer?: string; signature?: string } = {},
) {
  return verifyPayment({
    signature: overrides.signature ?? SIG,
    expectedBaseUnits: BigInt(overrides.amountUsd ?? 100) * 1_000_000n,
    wallet: WALLET,
    expectedPayer: overrides.expectedPayer,
    createdAtMs: WINDOW_START,
    expiresAtMs: WINDOW_END,
    fetchTransaction: async () => transaction,
  });
}

it("accepts a transfer that credits our wallet with at least the price", async () => {
  // The floor case: exactly the price, nothing more.
  const result = await check(tx({ after: "100000000" }));
  expect(result.ok).toBe(true);
  if (!result.ok) return;
  expect(result.amountBaseUnits).toBe(100_000_000n);
});

it("accepts an overpayment and reports what actually arrived", async () => {
  // The price is fixed and the binding is the signature, not the amount, so
  // more money is not a mismatch — it is simply recorded as what came in.
  // (The sibling verifier this file was copied from treats this as a failure
  // because it matches payments by exact amount; this product does not.)
  const result = await check(tx({ after: "150000000" }));
  expect(result.ok).toBe(true);
  if (!result.ok) return;
  expect(result.amountBaseUnits).toBe(150_000_000n);
});

it("rejects a transfer of a different mint", async () => {
  // wrong asset — anyone can deploy a token called USDC; only the real mint counts.
  const result = await check(tx({ mint: OTHER_MINT, after: "100000000" }));
  expect(result.ok).toBe(false);
  if (result.ok) return;
  expect(result.reason).toBe("wrong_token");
  expect(result.message).toMatch(/USDC/);
});

it("rejects a transfer to a different destination", async () => {
  // somebody else's wallet — real USDC moved, but not to our payment wallet.
  const result = await check(tx({ owner: PAYER, before: "0", after: "100000000" }));
  expect(result.ok).toBe(false);
  if (result.ok) return;
  expect(result.reason).toBe("wrong_destination");
});

it("rejects an underpayment", async () => {
  const result = await check(tx({ after: "99000000" }));
  expect(result.ok).toBe(false);
  if (result.ok) return;
  expect(result.reason).toBe("insufficient_amount");
});

it("rejects a transaction that failed on chain", async () => {
  const result = await check(
    tx({ err: { InstructionError: [0, "Custom"] }, after: "100000000" }),
  );
  expect(result.ok).toBe(false);
  if (result.ok) return;
  expect(result.reason).toBe("failed_tx");
});

it("rejects a transaction that is not yet confirmed", async () => {
  // getTransaction returns null both for "does not exist yet" and "not at
  // the requested commitment yet" — we cannot and do not try to tell them
  // apart, so both fail closed rather than being treated as paid.
  const missing = await check(null);
  expect(missing.ok).toBe(false);
  if (!missing.ok) expect(missing.reason).toBe("not_confirmed");

  const noResult = await check(tx({ noMeta: true }));
  expect(noResult.ok).toBe(false);
  if (!noResult.ok) expect(noResult.reason).toBe("not_confirmed");
});

describe("the block-time window", () => {
  // Fixed round numbers rather than the shared WINDOW_START/END, so the
  // skew-adjusted edges land on whole seconds and the arithmetic is easy to
  // check by eye.
  const CREATED_AT = 1_700_000_000_000;
  const EXPIRES_AT = CREATED_AT + 30 * 60_000;
  const SKEW_MS = BLOCKTIME_SKEW_SECONDS * 1000;

  async function checkAt(blockTimeMs: number) {
    return verifyPayment({
      signature: SIG,
      expectedBaseUnits: 100_000_000n,
      wallet: WALLET,
      createdAtMs: CREATED_AT,
      expiresAtMs: EXPIRES_AT,
      fetchTransaction: async () =>
        tx({ after: "100000000", blockTime: Math.floor(blockTimeMs / 1000) }),
    });
  }

  it("rejects a block time before the window opens", async () => {
    const result = await checkAt(CREATED_AT - SKEW_MS - 1000);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("outside_bid_window");
  });

  it("rejects a block time after the window closes", async () => {
    const result = await checkAt(EXPIRES_AT + SKEW_MS + 1000);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("outside_bid_window");
  });

  it("accepts a block time exactly on each edge of the window", async () => {
    const early = await checkAt(CREATED_AT - SKEW_MS);
    expect(early.ok).toBe(true);

    const late = await checkAt(EXPIRES_AT + SKEW_MS);
    expect(late.ok).toBe(true);
  });
});

it("names the sender when a real transfer did not match", async () => {
  // So support can reunite a stray payment with the person who actually sent
  // it, instead of trusting whatever order id someone claims it against.
  const result = await check(
    tx({ after: "50000000", payer: PAYER, payerBefore: "500000000", payerAfter: "450000000" }),
  );
  expect(result.ok).toBe(false);
  if (result.ok) return;
  expect(result.reason).toBe("insufficient_amount");
  expect(result.receivedBaseUnits).toBe(50_000_000n);
  expect(result.sender?.feePayer).toBe(PAYER);
  expect(result.sender?.debited).toEqual([{ owner: PAYER, amountBaseUnits: "50000000" }]);
});

it("rejects a payer that is not the wallet the order was opened with", async () => {
  // Without this check, anyone watching the chain can take a stranger's
  // transfer and claim it against their own order — first call to /confirm
  // wins, and the person who actually paid gets nothing.
  const result = await check(
    tx({
      after: "100000000",
      feePayer: PAYER,
      payer: PAYER,
      payerBefore: "500000000",
      payerAfter: "400000000",
    }),
    { expectedPayer: OTHER_PAYER },
  );
  expect(result.ok).toBe(false);
  if (result.ok) return;
  expect(result.reason).toBe("wrong_payer");
});

it("does not treat a blank expected payer as no binding at all", async () => {
  // "" is falsy in JS. A gate written as `if (params.expectedPayer)` would
  // silently skip the whole check for it — not "no match found" but "no
  // check performed", a false ok:true on exactly what this check exists to
  // catch. A present-but-blank value must instead fail closed as wrong_payer,
  // the same as any other wallet that is not the real payer.
  const paidByPayer = tx({
    after: "100000000",
    feePayer: PAYER,
    payer: PAYER,
    payerBefore: "500000000",
    payerAfter: "400000000",
  });

  const blank = await check(paidByPayer, { expectedPayer: "" });
  expect(blank.ok).toBe(false);
  if (!blank.ok) expect(blank.reason).toBe("wrong_payer");

  const whitespace = await check(paidByPayer, { expectedPayer: "   " });
  expect(whitespace.ok).toBe(false);
  if (!whitespace.ok) expect(whitespace.reason).toBe("wrong_payer");
});

it("checks the payer before the amount when both are wrong", async () => {
  // An underpayment can be topped up from the same wallet; a wrong-wallet
  // payment cannot be fixed by sending more from that same wrong wallet. The
  // failure the payer cannot fix themselves is the one they need to hear
  // about, so wrong_payer must win over insufficient_amount here.
  const result = await check(
    tx({
      after: "50000000",
      feePayer: PAYER,
      payer: PAYER,
      payerBefore: "500000000",
      payerAfter: "450000000",
    }),
    { expectedPayer: OTHER_PAYER },
  );
  expect(result.ok).toBe(false);
  if (result.ok) return;
  expect(result.reason).toBe("wrong_payer");
});

it("allows any payer when the order has no expected payer", async () => {
  // The paste-a-signature fallback has no connected wallet, so it has no
  // expected payer and cannot enforce this binding — first to claim wins,
  // inside the order's window, and the rules page says so.
  const result = await check(tx({ after: "100000000", feePayer: PAYER }));
  expect(result.ok).toBe(true);
});

it("accepts the payer when they are a debited USDC owner, not just the fee payer", async () => {
  // A relayed transaction can have a fee payer that never touches USDC while
  // the real buyer is the debited owner; the binding must accept either.
  const result = await check(
    tx({
      after: "100000000",
      feePayer: RELAYER,
      payer: OTHER_PAYER,
      payerBefore: "500000000",
      payerAfter: "400000000",
    }),
    { expectedPayer: OTHER_PAYER },
  );
  expect(result.ok).toBe(true);
});

it("sees a transfer made through a CPI", async () => {
  // The reason we read balance deltas rather than instruction shape: this
  // fixture models funds passing through an intermediate program-owned
  // account (as a CPI hop would produce) on the way to our wallet, with no
  // direct wallet-to-wallet instruction anywhere in it. verifyPayment never
  // looks at what produced a balance change, only the change itself, so this
  // passes exactly like a direct transfer would.
  const INTERMEDIATE = "5vN9uR3xkYPfJ7BFhCGDVzWJ1uYTLDXQoK4Vn5wCq3Rt";
  const transaction: SolanaTransaction = {
    slot: 1,
    blockTime: INSIDE,
    transaction: { message: { accountKeys: [{ pubkey: PAYER, signer: true }] } },
    meta: {
      err: null,
      preTokenBalances: [
        { accountIndex: 0, owner: PAYER, mint: USDC_MINT, uiTokenAmount: { amount: "200000000" } },
        { accountIndex: 1, owner: INTERMEDIATE, mint: USDC_MINT, uiTokenAmount: { amount: "0" } },
        { accountIndex: 2, owner: WALLET, mint: USDC_MINT, uiTokenAmount: { amount: "0" } },
      ],
      postTokenBalances: [
        { accountIndex: 0, owner: PAYER, mint: USDC_MINT, uiTokenAmount: { amount: "100000000" } },
        { accountIndex: 1, owner: INTERMEDIATE, mint: USDC_MINT, uiTokenAmount: { amount: "0" } },
        { accountIndex: 2, owner: WALLET, mint: USDC_MINT, uiTokenAmount: { amount: "100000000" } },
      ],
    },
  };
  const result = await check(transaction);
  expect(result.ok).toBe(true);
  if (!result.ok) return;
  expect(result.amountBaseUnits).toBe(100_000_000n);
});

describe("edges inherited from the sibling verifier", () => {
  it("rejects a malformed signature without calling the chain", async () => {
    let called = false;
    const result = await verifyPayment({
      signature: "not-a-signature",
      expectedBaseUnits: 100_000_000n,
      wallet: WALLET,
      createdAtMs: WINDOW_START,
      expiresAtMs: WINDOW_END,
      fetchTransaction: async () => {
        called = true;
        return null;
      },
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("invalid_signature");
    expect(called).toBe(false);
  });

  it("reports an unreachable RPC separately from a bad payment", async () => {
    const result = await verifyPayment({
      signature: SIG,
      expectedBaseUnits: 100_000_000n,
      wallet: WALLET,
      createdAtMs: WINDOW_START,
      expiresAtMs: WINDOW_END,
      fetchTransaction: async () => {
        throw new Error("node down");
      },
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("rpc_unavailable");
  });

  it("rejects a transaction with no confirmed block time yet", async () => {
    const result = await check(tx({ after: "100000000", blockTime: null }));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("no_block_time");
  });
});

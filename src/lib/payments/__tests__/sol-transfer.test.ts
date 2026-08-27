import { describe, expect, it } from "vitest";
import type { SolanaTransaction } from "../solana";
import { readSolTransfer, verifySolTransfer } from "../sol-transfer";

/**
 * The native SOL verifier, held to the same discipline as the USDC one.
 *
 * It exists because `verifyPayment` cannot do this: it reads
 * preTokenBalances/postTokenBalances and compares against a hardcoded mint,
 * and a native transfer produces no token balances at all. Lamports move in
 * preBalances/postBalances, which are POSITIONAL — indexed by accountKeys —
 * and which include the network fee on the payer's entry.
 */

const RECIPIENT = "7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU";
const PAYER = "SomeRandomPayerAddress1111111111111111111111";
const OTHER = "AnotherAccount22222222222222222222222222222";

function tx(options: {
  keys?: Array<{ pubkey: string; signer?: boolean }>;
  pre?: number[];
  post?: number[];
  blockTimeMs?: number;
  err?: unknown;
}): SolanaTransaction {
  return {
    slot: 1,
    blockTime: Math.floor((options.blockTimeMs ?? Date.now() - 60_000) / 1000),
    transaction: {
      message: {
        accountKeys: options.keys ?? [
          { pubkey: PAYER, signer: true },
          { pubkey: RECIPIENT, signer: false },
        ],
      },
    },
    meta: {
      err: options.err ?? null,
      preBalances: options.pre ?? [10_000_000, 0],
      postBalances: options.post ?? [6_995_000, 3_000_000],
    },
  };
}

describe("reading a native transfer", () => {
  it("reads what ARRIVED, not what the payer lost", () => {
    // The payer's balance fell by 3,005,000: the transfer plus the network
    // fee. Only the recipient's side says what actually arrived, and that is
    // the number the fee is checked against.
    const transfer = readSolTransfer(tx({}), RECIPIENT);
    expect(transfer).toEqual({ payer: PAYER, lamports: 3_000_000n });
  });

  it("names the signer who lost the most as the payer", () => {
    // A transaction can move lamports between several accounts. Requiring
    // `signer` stops an account that merely lost rent from being named as
    // having paid.
    const transfer = readSolTransfer(
      tx({
        keys: [
          { pubkey: OTHER, signer: false },
          { pubkey: PAYER, signer: true },
          { pubkey: RECIPIENT, signer: false },
        ],
        pre: [50_000, 10_000_000, 0],
        post: [40_000, 6_995_000, 3_000_000],
      }),
      RECIPIENT,
    );
    expect(transfer!.payer).toBe(PAYER);
  });

  it("returns null when nothing reached the recipient", () => {
    expect(
      readSolTransfer(
        tx({
          keys: [
            { pubkey: PAYER, signer: true },
            { pubkey: OTHER, signer: false },
          ],
          pre: [10_000_000, 0],
          post: [6_995_000, 3_000_000],
        }),
        RECIPIENT,
      ),
    ).toBeNull();
  });

  it("returns null on a malformed transaction rather than guessing", () => {
    // Balance arrays that do not line up with accountKeys cannot be indexed
    // safely, and a positional read of mismatched arrays is how a verifier
    // credits the wrong account.
    expect(readSolTransfer(tx({ pre: [1], post: [1, 2] }), RECIPIENT)).toBeNull();
    expect(readSolTransfer(null, RECIPIENT)).toBeNull();
  });
});

describe("verifying a registration payment", () => {
  const fee = 3_000_000n;
  const fetcher = (transaction: SolanaTransaction) => async () => transaction;

  it("accepts a transfer of exactly the fee", async () => {
    const result = await verifySolTransfer({
      signature: "sig", recipient: RECIPIENT, minLamports: fee,
      fetchTransaction: fetcher(tx({})),
    });
    expect(result).toMatchObject({ ok: true, payer: PAYER, lamports: 3_000_000n });
  });

  it("accepts more than the fee", async () => {
    const result = await verifySolTransfer({
      signature: "sig", recipient: RECIPIENT, minLamports: fee,
      fetchTransaction: fetcher(tx({ post: [1_000_000, 9_000_000] })),
    });
    expect(result.ok).toBe(true);
  });

  it("refuses less than the fee", async () => {
    expect(
      await verifySolTransfer({
        signature: "sig", recipient: RECIPIENT, minLamports: fee,
        fetchTransaction: fetcher(tx({ post: [8_995_000, 1_000_000] })),
      }),
    ).toMatchObject({ ok: false, reason: "insufficient_amount" });
  });

  it("refuses a transaction that failed on chain", async () => {
    // It can still be fetched and still name a recipient. It moved nothing.
    expect(
      await verifySolTransfer({
        signature: "sig", recipient: RECIPIENT, minLamports: fee,
        fetchTransaction: fetcher(tx({ err: { InstructionError: [0, "Custom"] } })),
      }),
    ).toMatchObject({ ok: false, reason: "failed_on_chain" });
  });

  it("refuses a transaction with no block time rather than assuming one", async () => {
    const noTime = tx({});
    (noTime as { blockTime?: number | null }).blockTime = null;
    expect(
      await verifySolTransfer({
        signature: "sig", recipient: RECIPIENT, minLamports: fee,
        fetchTransaction: fetcher(noTime),
      }),
    ).toMatchObject({ ok: false, reason: "no_block_time" });
  });

  it("refuses a transfer older than the window", async () => {
    // Without an age bound, any historical transfer to the receiving wallet —
    // made for any reason, including a token entry payment — could be
    // presented as a registration fee.
    expect(
      await verifySolTransfer({
        signature: "sig", recipient: RECIPIENT, minLamports: fee,
        fetchTransaction: fetcher(tx({ blockTimeMs: Date.now() - 40 * 3_600_000 })),
      }),
    ).toMatchObject({ ok: false, reason: "too_old" });
  });

  it("reports an unreachable RPC as ours, not as the payer's fault", async () => {
    expect(
      await verifySolTransfer({
        signature: "sig", recipient: RECIPIENT, minLamports: fee,
        fetchTransaction: async () => { throw new Error("network"); },
      }),
    ).toMatchObject({ ok: false, reason: "rpc_unavailable" });
  });

  it("accepts anything when the fee is switched off", async () => {
    // REGISTRATION_FEE_SOL=0 is the owner's door. A zero minimum still
    // requires a real transfer to have happened — the payer is derived from
    // it — but any amount clears the bar.
    const result = await verifySolTransfer({
      signature: "sig", recipient: RECIPIENT, minLamports: 0n,
      fetchTransaction: fetcher(tx({ post: [9_999_000, 1] })),
    });
    expect(result).toMatchObject({ ok: true, payer: PAYER });
  });
});

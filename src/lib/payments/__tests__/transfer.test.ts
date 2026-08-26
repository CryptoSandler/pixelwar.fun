import { describe, expect, it, vi } from "vitest";
import { Keypair, PublicKey, type Connection } from "@solana/web3.js";
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  associatedTokenAddress,
  buildPaymentTransaction,
  transferCheckedInstruction,
} from "../transfer";
import { USDC_DECIMALS, USDC_MINT, usdToBaseUnits } from "../config";

/**
 * The reference account is the one part of a payment that nothing about the
 * happy path can check. A transfer missing it, or carrying it with the wrong
 * flags, moves exactly the same money and settles exactly the same way — the
 * damage only appears later, when a payer closes their tab before confirming
 * and `recover.ts` searches the chain for a transaction that does not name
 * the key it is searching by. So these assertions are about flags and
 * positions, not about outcomes.
 */

const MINT = new PublicKey(USDC_MINT);
const PAYER = new PublicKey("7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU");
const RECIPIENT = new PublicKey("DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263");

function reference(): PublicKey {
  return Keypair.generate().publicKey;
}

function params(overrides: Partial<Parameters<typeof transferCheckedInstruction>[0]> = {}) {
  return {
    payer: PAYER,
    recipient: RECIPIENT,
    mint: MINT,
    decimals: USDC_DECIMALS,
    amountBaseUnits: usdToBaseUnits(25),
    reference: reference(),
    ...overrides,
  };
}

/** A connection that answers the two lookups `buildPaymentTransaction` makes. */
function fakeConnection(accounts: { source: boolean; destination: boolean }): Connection {
  const source = associatedTokenAddress(PAYER, MINT).toBase58();
  const destination = associatedTokenAddress(RECIPIENT, MINT).toBase58();
  return {
    getAccountInfo: vi.fn(async (key: PublicKey) => {
      if (key.toBase58() === source) return accounts.source ? { lamports: 1 } : null;
      if (key.toBase58() === destination) return accounts.destination ? { lamports: 1 } : null;
      return null;
    }),
    getLatestBlockhash: vi.fn(async () => ({
      blockhash: "11111111111111111111111111111111",
      lastValidBlockHeight: 1,
    })),
  } as unknown as Connection;
}

describe("the transfer instruction", () => {
  it("carries the reference as an account that neither signs nor is written", () => {
    const input = params();
    const instruction = transferCheckedInstruction(input);

    const key = instruction.keys.find((k) => k.pubkey.equals(input.reference));
    expect(key).toBeDefined();
    expect(key!.isSigner).toBe(false);
    expect(key!.isWritable).toBe(false);
  });

  it("puts the reference last, after the four accounts the token program reads", () => {
    const input = params();
    const instruction = transferCheckedInstruction(input);

    expect(instruction.programId.equals(TOKEN_PROGRAM_ID)).toBe(true);
    expect(instruction.keys).toHaveLength(5);
    expect(instruction.keys[4].pubkey.equals(input.reference)).toBe(true);
    // Source and destination are the only writable accounts; the owner is the
    // only signer.
    expect(instruction.keys.map((k) => k.isWritable)).toEqual([true, false, true, false, false]);
    expect(instruction.keys.map((k) => k.isSigner)).toEqual([false, false, false, true, false]);
  });

  it("encodes TransferChecked with the amount in base units and the mint's decimals", () => {
    const instruction = transferCheckedInstruction(params({ amountBaseUnits: usdToBaseUnits(25) }));
    const data = new Uint8Array(instruction.data);

    expect(data).toHaveLength(10);
    expect(data[0]).toBe(12);
    expect(new DataView(data.buffer, data.byteOffset).getBigUint64(1, true)).toBe(25_000_000n);
    expect(data[9]).toBe(USDC_DECIMALS);
  });

  it("moves USDC between associated token accounts, not between wallets", () => {
    const instruction = transferCheckedInstruction(params());
    expect(instruction.keys[0].pubkey.equals(associatedTokenAddress(PAYER, MINT))).toBe(true);
    expect(instruction.keys[2].pubkey.equals(associatedTokenAddress(RECIPIENT, MINT))).toBe(true);
    // A derived token account is off the ed25519 curve — nobody holds a
    // private key for it, which is what makes it derivable in the first place.
    expect(PublicKey.isOnCurve(associatedTokenAddress(PAYER, MINT).toBytes())).toBe(false);
  });
});

describe("the transaction a wallet is handed", () => {
  it("keeps the reference read-only and unsigned once the message is compiled", async () => {
    const input = params();
    const built = await buildPaymentTransaction(fakeConnection({ source: true, destination: true }), input);
    expect(built.ok).toBe(true);
    if (!built.ok) return;

    // Compiling is where a flag would actually be lost: web3.js merges the
    // per-instruction flags into one account list, and an account named
    // writable by any instruction is writable for the whole message.
    const message = built.transaction.compileMessage();
    const index = message.accountKeys.findIndex((key) => key.equals(input.reference));
    expect(index).toBeGreaterThan(-1);
    expect(message.isAccountSigner(index)).toBe(false);
    expect(message.isAccountWritable(index)).toBe(false);

    // The payer is the only signature the transaction asks for.
    expect(message.header.numRequiredSignatures).toBe(1);
    expect(message.accountKeys[0].equals(PAYER)).toBe(true);
  });

  it("opens the recipient's token account when it does not exist yet", async () => {
    const built = await buildPaymentTransaction(
      fakeConnection({ source: true, destination: false }),
      params(),
    );
    expect(built.ok).toBe(true);
    if (!built.ok) return;

    expect(built.transaction.instructions).toHaveLength(2);
    expect(built.transaction.instructions[0].programId.equals(ASSOCIATED_TOKEN_PROGRAM_ID)).toBe(true);
    expect(built.transaction.instructions[0].data).toEqual(Buffer.from([1]));
    expect(built.transaction.instructions[1].programId.equals(TOKEN_PROGRAM_ID)).toBe(true);
  });

  it("does not open an account that is already there", async () => {
    const built = await buildPaymentTransaction(
      fakeConnection({ source: true, destination: true }),
      params(),
    );
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    expect(built.transaction.instructions).toHaveLength(1);
  });

  it("refuses before signing when the payer holds no USDC at all", async () => {
    const built = await buildPaymentTransaction(
      fakeConnection({ source: false, destination: true }),
      params(),
    );
    expect(built.ok).toBe(false);
    if (built.ok) return;
    expect(built.message).toContain("no USDC");
  });

  it("reports an unreachable cluster rather than handing over a transaction with no blockhash", async () => {
    const connection = {
      getAccountInfo: vi.fn(async () => ({ lamports: 1 })),
      getLatestBlockhash: vi.fn(async () => {
        throw new Error("network");
      }),
    } as unknown as Connection;

    const built = await buildPaymentTransaction(connection, params());
    expect(built.ok).toBe(false);
    if (built.ok) return;
    expect(built.message).toContain("Solana network");
  });
});

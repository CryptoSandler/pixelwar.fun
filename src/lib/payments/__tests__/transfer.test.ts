import { describe, expect, it } from "vitest";
import { Keypair, PublicKey, SystemProgram } from "@solana/web3.js";
import type { Connection } from "@solana/web3.js";
import { buildSolTransfer } from "../transfer";

/**
 * The payer's side of an admission, since it moved to SOL.
 *
 * WHAT THIS FILE USED TO TEST, and why almost none of it survived: it pulled
 * apart a hand-encoded SPL `transferChecked` and an idempotent
 * associated-account creation, byte by byte, because those layouts were
 * written here rather than taken from a dependency. Admission is a native
 * transfer now, `SystemProgram.transfer` does the encoding, and testing
 * web3.js's own instruction builder would be testing somebody else's library.
 *
 * What is left is the part that was always this module's real job and the
 * reason it is a module: THE REFERENCE ACCOUNT. A transfer with the reference
 * missing, or attached with the wrong flags, is indistinguishable from a
 * correct one until a payer closes their tab and `recover.ts` cannot find
 * their money.
 */

const PAYER = Keypair.generate().publicKey;
const RECIPIENT = Keypair.generate().publicKey;
const REFERENCE = Keypair.generate().publicKey;

/** Enough of a Connection to answer the one call `buildSolTransfer` makes. */
function connection(overrides: Partial<{ fail: boolean }> = {}): Connection {
  return {
    getLatestBlockhash: async () => {
      if (overrides.fail) throw new Error("network");
      return { blockhash: "11111111111111111111111111111111", lastValidBlockHeight: 100 };
    },
  } as unknown as Connection;
}

describe("the admission transfer", () => {
  it("moves the lamports the order asks for, from payer to recipient", async () => {
    const built = await buildSolTransfer(connection(), {
      payer: PAYER,
      recipient: RECIPIENT,
      lamports: 10_000_000n,
      reference: REFERENCE,
    });

    expect(built.ok).toBe(true);
    if (!built.ok) throw new Error("unreachable");
    expect(built.transaction.instructions).toHaveLength(1);

    const instruction = built.transaction.instructions[0];
    expect(instruction.programId.equals(SystemProgram.programId)).toBe(true);
    expect(instruction.keys[0].pubkey.equals(PAYER)).toBe(true);
    expect(instruction.keys[1].pubkey.equals(RECIPIENT)).toBe(true);
    expect(built.transaction.feePayer?.equals(PAYER)).toBe(true);
  });

  it("carries the reference as a read-only, non-signing account, LAST", async () => {
    // Appended rather than inserted, and the position is the point: the
    // System Program reads its two accounts positionally, so a reference put
    // anywhere but the end would move the accounts it does read.
    const built = await buildSolTransfer(connection(), {
      payer: PAYER,
      recipient: RECIPIENT,
      lamports: 10_000_000n,
      reference: REFERENCE,
    });
    if (!built.ok) throw new Error("unreachable");

    const keys = built.transaction.instructions[0].keys;
    const reference = keys[keys.length - 1];
    expect(reference.pubkey.equals(REFERENCE)).toBe(true);
    expect(reference.isSigner).toBe(false);
    expect(reference.isWritable).toBe(false);
    // And the two the program actually reads are still where it expects them.
    expect(keys[0].pubkey.equals(PAYER)).toBe(true);
    expect(keys[1].pubkey.equals(RECIPIENT)).toBe(true);
  });

  it("omits the reference when there is no order behind the payment", async () => {
    // A painter's registration. Nothing has to find it later — the payer
    // hands us the signature — so there is no reference to attach, and this
    // asserts the absence rather than leaving it to be assumed.
    const built = await buildSolTransfer(connection(), {
      payer: PAYER,
      recipient: RECIPIENT,
      lamports: 3_000_000n,
    });
    if (!built.ok) throw new Error("unreachable");

    const keys = built.transaction.instructions[0].keys;
    expect(keys).toHaveLength(2);
    expect(keys.some((key) => key.pubkey.equals(REFERENCE))).toBe(false);
  });

  it("refuses rather than building an unsignable transaction when the node is down", async () => {
    // Without a blockhash the wallet would be handed something it cannot
    // sign, and the payer would meet the failure inside their wallet dialog.
    const built = await buildSolTransfer(connection({ fail: true }), {
      payer: PAYER,
      recipient: RECIPIENT,
      lamports: 10_000_000n,
      reference: REFERENCE,
    });
    expect(built).toMatchObject({ ok: false });
    if (built.ok) throw new Error("unreachable");
    expect(built.message).toContain("did not answer");
  });

  it("keeps the recipient exactly as given", async () => {
    // A transfer that quietly rounds, derives or normalises the destination
    // is the one bug in this file nobody would catch by looking at a screen.
    const other = new PublicKey(Keypair.generate().publicKey.toBytes());
    const built = await buildSolTransfer(connection(), {
      payer: PAYER,
      recipient: other,
      lamports: 1n,
    });
    if (!built.ok) throw new Error("unreachable");
    expect(built.transaction.instructions[0].keys[1].pubkey.toBase58()).toBe(other.toBase58());
  });
});

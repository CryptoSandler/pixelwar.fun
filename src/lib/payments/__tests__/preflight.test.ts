import { afterEach, describe, expect, it, vi } from "vitest";
import { ASSUMED_FEE_LAMPORTS, messageOf, preflight } from "../preflight";
import { MultipleSignersError, requireSingleSigner } from "../send";
import { Keypair, PublicKey, SystemProgram, Transaction } from "@solana/web3.js";

/**
 * The pre-flight, one branch at a time.
 *
 * WHAT IT IS FOR, restated because it decides what these tests assert:
 * Phantom shows "this transaction may be malicious" for anything that fails
 * simulation, INCLUDING a payer who is simply out of SOL. Every branch below
 * is a case where the person must hear our sentence instead of that one.
 */

const PAYER = Keypair.generate().publicKey.toBase58();

/** An RPC that answers from a script, and records what it was asked. */
function rpc(answers: Record<string, unknown>, asked: string[] = []) {
  return async (method: string) => {
    asked.push(method);
    if (answers[method] instanceof Error) throw answers[method];
    return answers[method];
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("what a refusal writes down", () => {
  /**
   * The first rehearsal on production stopped at exactly one of these and
   * nothing recorded why: the verdict is not stored, so an hour later the
   * only evidence was two rows in a counter. These assert the line exists —
   * and, just as hard, that it does not name the person.
   */
  it("records the shortfall, and never the payer", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await preflight({
      transactionBase64: "AA==",
      payer: PAYER,
      lamports: 10_000_000n,
      rpc: rpc({ getBalance: { value: 9_000_000 }, getFeeForMessage: { value: 5_000 } }),
    });

    const line = warn.mock.calls.map((call) => call.join(" ")).join("\n");
    expect(line).toContain("insufficient_funds");
    // The number that tells "off by a network fee" from "empty wallet".
    expect(line).toContain("1005000");
    // The identity, which is nobody's business in a log.
    expect(line).not.toContain(PAYER);
  });

  it("records the chain's own error when a simulation fails, still without the payer", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await preflight({
      transactionBase64: "AA==",
      payer: PAYER,
      lamports: 1n,
      rpc: rpc({
        getBalance: { value: 900_000_000 },
        getFeeForMessage: { value: 5_000 },
        simulateTransaction: { value: { err: { InstructionError: [0, "Custom"] }, logs: ["Program failed"] } },
      }),
    });

    const line = warn.mock.calls.map((call) => JSON.stringify(call)).join("\n");
    expect(line).toContain("simulation_failed");
    // The diagnosis, which the payer never sees and we always need.
    expect(line).toContain("InstructionError");
    expect(line).toContain("Program failed");
    expect(line).not.toContain(PAYER);
  });

  it("says nothing at all when the check passes", async () => {
    // A log line per successful payment would be noise that hides the ones
    // that matter.
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await preflight({
      transactionBase64: "AA==",
      payer: PAYER,
      lamports: 1n,
      rpc: rpc({
        getBalance: { value: 900_000_000 },
        getFeeForMessage: { value: 5_000 },
        simulateTransaction: { value: { err: null } },
      }),
    });
    expect(warn).not.toHaveBeenCalled();
  });
});

describe("can this payer afford it", () => {
  it("passes when the balance covers the amount and the fee", async () => {
    const result = await preflight({
      transactionBase64: "AA==",
      payer: PAYER,
      lamports: 10_000_000n,
      rpc: rpc({
        getBalance: { value: 20_000_000 },
        getFeeForMessage: { value: 5_000 },
        simulateTransaction: { value: { err: null, logs: [] } },
      }),
    });
    expect(result).toMatchObject({ ok: true, feeLamports: 5_000n });
  });

  it("refuses when the balance covers the amount but NOT the fee", async () => {
    // The case that would otherwise reach a wallet and come back as "may be
    // malicious": the payer has exactly the price and nothing for the fee.
    const result = await preflight({
      transactionBase64: "AA==",
      payer: PAYER,
      lamports: 10_000_000n,
      rpc: rpc({
        getBalance: { value: 10_000_000 },
        getFeeForMessage: { value: 5_000 },
        simulateTransaction: { value: { err: null } },
      }),
    });
    expect(result).toMatchObject({ ok: false, reason: "insufficient_funds" });
    if (result.ok) throw new Error("unreachable");
    // The sentence names the number that fixes it, and no developer string.
    expect(result.message).toContain("0.000005");
    expect(result.message).toContain("more SOL");
    expect(result.message).not.toMatch(/0x|error|simulat/i);
  });

  it("does not simulate at all once the balance has already failed", async () => {
    // The cheap question first: a simulation call spends the same RPC quota
    // every live checkout shares, and the answer cannot change the verdict.
    const asked: string[] = [];
    await preflight({
      transactionBase64: "AA==",
      payer: PAYER,
      lamports: 10_000_000n,
      rpc: rpc({ getBalance: { value: 1 }, getFeeForMessage: { value: 5_000 } }, asked),
    });
    expect(asked).not.toContain("simulateTransaction");
  });

  it("assumes one signature's fee when the node will not price the message", async () => {
    // A node that cannot answer must not stop somebody paying. Being wrong in
    // the payer's favour costs nothing; refusing a payment that would have
    // worked is the expensive direction.
    const result = await preflight({
      transactionBase64: "AA==",
      payer: PAYER,
      lamports: 1_000n,
      rpc: rpc({
        getBalance: { value: 1_000n + ASSUMED_FEE_LAMPORTS > 0 ? 6_000 : 0 },
        getFeeForMessage: { value: null },
        simulateTransaction: { value: { err: null } },
      }),
    });
    expect(result).toMatchObject({ ok: true, feeLamports: ASSUMED_FEE_LAMPORTS });
  });
});

describe("would it actually run", () => {
  it("refuses a transaction the chain says would fail", async () => {
    const result = await preflight({
      transactionBase64: "AA==",
      payer: PAYER,
      lamports: 1_000n,
      rpc: rpc({
        getBalance: { value: 900_000_000 },
        getFeeForMessage: { value: 5_000 },
        simulateTransaction: { value: { err: { InstructionError: [0, "Custom"] }, logs: ["boom"] } },
      }),
    });
    expect(result).toMatchObject({ ok: false, reason: "simulation_failed" });
    if (result.ok) throw new Error("unreachable");
    // The raw error stays on the server. DESIGN.md §8.
    expect(result.message).not.toContain("InstructionError");
    expect(result.message).not.toContain("boom");
    expect(result.message).toContain("Nothing has been charged");
  });

  it("simulates WITHOUT signature verification, because nothing is signed yet", async () => {
    // The whole point is to ask before the wallet opens. sigVerify:true would
    // fail every single time and the check would be theatre.
    const seen: unknown[] = [];
    await preflight({
      transactionBase64: "AA==",
      payer: PAYER,
      lamports: 1n,
      rpc: async (method, params) => {
        if (method === "simulateTransaction") seen.push(params[1]);
        if (method === "getBalance") return { value: 900_000_000 };
        if (method === "getFeeForMessage") return { value: 5_000 };
        return { value: { err: null } };
      },
    });
    expect(seen[0]).toMatchObject({ sigVerify: false });
  });

  it("reports an unreachable node as ours, not as the payer's fault", async () => {
    const result = await preflight({
      transactionBase64: "AA==",
      payer: PAYER,
      lamports: 1n,
      rpc: rpc({ getBalance: new Error("network") }),
    });
    expect(result).toMatchObject({ ok: false, reason: "rpc_unavailable" });
  });

  it("treats a node that answers nonsense as unreachable rather than as a pass", async () => {
    const result = await preflight({
      transactionBase64: "AA==",
      payer: PAYER,
      lamports: 1n,
      rpc: rpc({ getBalance: {} }),
    });
    expect(result).toMatchObject({ ok: false, reason: "rpc_unavailable" });
  });
});

describe("the message a fee is quoted for", () => {
  it("skips the empty signature slots of an unsigned transaction", () => {
    // One signer: a single 0x01 count byte, 64 zero bytes, then the message.
    const message = Buffer.from([9, 9, 9]);
    const serialized = Buffer.concat([Buffer.from([1]), Buffer.alloc(64), message]);
    expect(messageOf(serialized.toString("base64"))).toBe(message.toString("base64"));
  });
});

describe("exactly one signer reaches the wallet", () => {
  const payer = Keypair.generate().publicKey;
  const recipient = Keypair.generate().publicKey;
  const reference = Keypair.generate().publicKey;

  function transfer(): Transaction {
    const instruction = SystemProgram.transfer({
      fromPubkey: payer,
      toPubkey: recipient,
      lamports: 1_000n,
    });
    instruction.keys.push({ pubkey: reference, isSigner: false, isWritable: false });
    const transaction = new Transaction().add(instruction);
    transaction.feePayer = payer;
    return transaction;
  }

  it("accepts the transaction this project actually builds", () => {
    // The reference rides along and must NOT count: it is read-only and
    // signs nothing.
    expect(() => requireSingleSigner(transfer(), payer.toBase58())).not.toThrow();
  });

  it("refuses a transaction that would ask a second wallet to sign", () => {
    // The shape of every drainer prompt anybody has been trained to fear, and
    // the reason this is asserted before the wallet opens rather than trusted
    // from whichever builder is upstream today.
    const transaction = transfer();
    transaction.instructions[0].keys.push({
      pubkey: new PublicKey(Keypair.generate().publicKey.toBytes()),
      isSigner: true,
      isWritable: false,
    });
    expect(() => requireSingleSigner(transaction, payer.toBase58())).toThrow(MultipleSignersError);
  });

  it("refuses when the one signer is somebody other than the connected wallet", () => {
    const stranger = Keypair.generate().publicKey.toBase58();
    expect(() => requireSingleSigner(transfer(), stranger)).toThrow(MultipleSignersError);
  });
});

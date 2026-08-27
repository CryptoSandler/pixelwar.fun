import { generateKeyPairSync, randomBytes, sign as signEd25519 } from "node:crypto";
import { describe, expect, it } from "vitest";
import { base58Encode } from "../../base58";
import { makeToken, makeWar } from "../../canvas/__tests__/fixtures";
import { execute, queryOne } from "../../db";
import { allegianceOf } from "../allegiance";
import { issueOathChallenge, swearOath, verifyWalletSignature } from "../oath";
import { paintPixel } from "../paint";

/**
 * The oath, which is the one part of allegiance built as security.
 *
 * The recruit's lock is a cookie and migration 009 says so out loud. This
 * grants a mark other people can see, on the strength of a claim about a
 * wallet — and a badge that can be forged launders sybils into credentials,
 * which is worse than having no badge at all.
 */

const MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";

/** A real Ed25519 keypair, used the way a wallet would use one. */
function wallet() {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const raw = publicKey.export({ format: "der", type: "spki" }).subarray(-32);
  return {
    address: base58Encode(new Uint8Array(raw)),
    sign: (message: string) =>
      base58Encode(new Uint8Array(signEd25519(null, Buffer.from(message, "utf8"), privateKey))),
  };
}

const holds = async () => 1_000n;
const holdsNothing = async () => 0n;

describe("verifyWalletSignature", () => {
  it("accepts a real signature from the key that made it", () => {
    const w = wallet();
    expect(
      verifyWalletSignature({ wallet: w.address, message: "hello", signatureBase58: w.sign("hello") }),
    ).toBe(true);
  });

  it("rejects the same signature over different bytes", () => {
    const w = wallet();
    const signature = w.sign("hello");
    expect(verifyWalletSignature({ wallet: w.address, message: "hello!", signatureBase58: signature })).toBe(false);
  });

  it("rejects a valid signature from a different wallet", () => {
    const a = wallet();
    const b = wallet();
    expect(
      verifyWalletSignature({ wallet: a.address, message: "hello", signatureBase58: b.sign("hello") }),
    ).toBe(false);
  });

  it("answers false for every kind of malformed input rather than throwing", () => {
    // One answer for every kind of wrong. Telling a malformed signature apart
    // from a valid one by the wrong key is an oracle, and neither is getting in.
    const w = wallet();
    for (const [address, signature] of [
      ["", w.sign("x")],
      ["not-base58-!!!", w.sign("x")],
      [w.address, ""],
      [w.address, "0oIl"],
      [base58Encode(new Uint8Array(randomBytes(31))), w.sign("x")],
    ] as const) {
      expect(
        verifyWalletSignature({ wallet: address, message: "x", signatureBase58: signature }),
        `${address.slice(0, 8)}/${signature.slice(0, 8)}`,
      ).toBe(false);
    }
  });
});

describe("swearing", () => {
  async function setup() {
    const war = await makeWar({ width: 8, height: 8 });
    const token = await makeToken(war.id, 3);
    const challenge = await issueOathChallenge({ warId: war.id, warSlug: war.slug, ticker: "T3" });
    return { war, token, challenge };
  }

  it("marks a holder sworn and binds the wallet", { timeout: 30_000 }, async () => {
    const { war, token, challenge } = await setup();
    const w = wallet();

    const result = await swearOath({
      warId: war.id, warTokenId: token, mint: MINT, painterKey: "sw1",
      wallet: w.address, nonce: challenge.nonce,
      signatureBase58: w.sign(challenge.message), fetchHolding: holds,
    });

    expect(result).toMatchObject({ ok: true, wallet: w.address });
    const bound = await allegianceOf(war.id, "sw1");
    expect(bound).toMatchObject({ warTokenId: token, wallet: w.address });
    expect(bound!.swornAt).not.toBeNull();
  });

  it("spends the nonce, so the same signature cannot be replayed", { timeout: 30_000 }, async () => {
    const { war, token, challenge } = await setup();
    const w = wallet();
    const signature = w.sign(challenge.message);
    const args = {
      warId: war.id, warTokenId: token, mint: MINT, painterKey: "sw2",
      wallet: w.address, nonce: challenge.nonce, signatureBase58: signature,
      fetchHolding: holds,
    };

    expect((await swearOath(args)).ok).toBe(true);
    // ONE SIGNATURE, ONE USE. A fixed message would be signed once and
    // reusable forever, by anybody who ever saw it.
    expect(await swearOath({ ...args, painterKey: "sw2b" })).toMatchObject({
      ok: false, reason: "nonce_spent",
    });
  });

  it("refuses an expired challenge", { timeout: 30_000 }, async () => {
    const { war, token, challenge } = await setup();
    const w = wallet();
    // Both timestamps move: the table has CHECK (expires_at > issued_at), and
    // a fixture that only winds the expiry back describes a row the schema
    // will not store. The constraint caught this test, which is the right way
    // round.
    await execute(
      `UPDATE oath_nonces
          SET issued_at = now() - interval '10 minutes',
              expires_at = now() - interval '1 second'
        WHERE nonce = $1`,
      [challenge.nonce],
    );

    expect(
      await swearOath({
        warId: war.id, warTokenId: token, mint: MINT, painterKey: "sw3",
        wallet: w.address, nonce: challenge.nonce,
        signatureBase58: w.sign(challenge.message), fetchHolding: holds,
      }),
    ).toMatchObject({ ok: false, reason: "nonce_expired" });
  });

  it("refuses a nonce issued for another war", { timeout: 30_000 }, async () => {
    const first = await setup();
    const second = await makeWar({ width: 8, height: 8 });
    const otherToken = await makeToken(second.id, 9);
    const w = wallet();

    // The war is IN the signed message, so a signature from one war cannot
    // swear in the next.
    expect(
      await swearOath({
        warId: second.id, warTokenId: otherToken, mint: MINT, painterKey: "sw4",
        wallet: w.address, nonce: first.challenge.nonce,
        signatureBase58: w.sign(first.challenge.message), fetchHolding: holds,
      }),
    ).toMatchObject({ ok: false, reason: "wrong_war" });
  });

  it("refuses a wallet that holds none of the token", { timeout: 30_000 }, async () => {
    const { war, token, challenge } = await setup();
    const w = wallet();

    expect(
      await swearOath({
        warId: war.id, warTokenId: token, mint: MINT, painterKey: "sw5",
        wallet: w.address, nonce: challenge.nonce,
        signatureBase58: w.sign(challenge.message), fetchHolding: holdsNothing,
      }),
    ).toMatchObject({ ok: false, reason: "not_a_holder" });
  });

  it("spends the nonce even when the signature is wrong", { timeout: 30_000 }, async () => {
    // ORDER MATTERS. The nonce is spent before the signature is looked at, so
    // a replay cannot sit on a live nonce burning RPC quota by failing
    // verification over and over.
    const { war, token, challenge } = await setup();
    const w = wallet();

    expect(
      await swearOath({
        warId: war.id, warTokenId: token, mint: MINT, painterKey: "sw6",
        wallet: w.address, nonce: challenge.nonce,
        signatureBase58: w.sign("something else"), fetchHolding: holds,
      }),
    ).toMatchObject({ ok: false, reason: "bad_signature" });

    const spent = await queryOne<{ used_at: Date | null }>(
      `SELECT used_at FROM oath_nonces WHERE nonce = $1`, [challenge.nonce],
    );
    expect(spent!.used_at).not.toBeNull();
  });

  it("will not swear for a token the painter is already committed against", { timeout: 30_000 }, async () => {
    const { war, token, challenge } = await setup();
    const other = await makeToken(war.id, 9);
    const w = wallet();

    await paintPixel({
      war, x: 0, y: 0, tokenId: token, colourSlot: 7,
      painterKey: "sw7", ipHash: "ip-sw7", subnetKey: "sn-sw7",
    });

    expect(
      await swearOath({
        warId: war.id, warTokenId: other, mint: MINT, painterKey: "sw7",
        wallet: w.address, nonce: challenge.nonce,
        signatureBase58: w.sign(challenge.message), fetchHolding: holds,
      }),
    ).toMatchObject({ ok: false, reason: "already_committed" });
  });

  it("will not let one wallet swear to two sides of the same war", { timeout: 30_000 }, async () => {
    const { war, token, challenge } = await setup();
    const w = wallet();
    await swearOath({
      warId: war.id, warTokenId: token, mint: MINT, painterKey: "sw8",
      wallet: w.address, nonce: challenge.nonce,
      signatureBase58: w.sign(challenge.message), fetchHolding: holds,
    });

    const second = await issueOathChallenge({ warId: war.id, warSlug: war.slug, ticker: "T3" });
    // A recruit can start over by clearing a cookie. A wallet cannot — this
    // is the half of the mechanic that is genuinely enforced.
    expect(
      await swearOath({
        warId: war.id, warTokenId: token, mint: MINT, painterKey: "sw8-other-cookie",
        wallet: w.address, nonce: second.nonce,
        signatureBase58: w.sign(second.message), fetchHolding: holds,
      }),
    ).toMatchObject({ ok: false, reason: "wallet_taken" });
  });

  it("asks the wallet to sign something a human can read", { timeout: 30_000 }, async () => {
    const { challenge } = await setup();
    // Somebody is about to approve this in a dialog. A wallet that shows a
    // blob of base64 has trained that person to approve blobs of base64.
    expect(challenge.message).toContain("pixelwar.fun");
    expect(challenge.message).toContain("It moves no funds.");
    expect(challenge.message).toContain(challenge.nonce);
    // And nothing in it promises the oath cannot be undone.
    expect(challenge.message).not.toMatch(/permanent|irrevocable|forever|never/i);
  });
});

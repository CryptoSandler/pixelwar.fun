import { generateKeyPairSync, sign as signEd25519 } from "node:crypto";
import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import { base58Encode } from "../../base58";
import { makeToken, makeWar, registerPainter } from "../../canvas/__tests__/fixtures";
import { banKey } from "../../moderation";
import { query } from "../../db";
import type { SolanaTransaction } from "../../payments/solana";
import { paintPixel } from "../paint";
import {
  isRegistered,
  issueLinkChallenge,
  linkedWallet,
  linkWallet,
  register,
} from "../registration";

/**
 * Registration: the gate, the idempotency, and the re-link.
 *
 * Held to the discipline the USDC checkout is held to, because it is the same
 * kind of surface: money arrives, a server decides what it bought, and every
 * input reaching that decision came from the caller.
 */

const PAYER = "4Nd1mBQtrMJVYVfKf2PJy9NCYYkfkkZuAExL6cQqLKPn";
const RECIPIENT = "7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU";

beforeEach(() => {
  process.env.PAYMENT_WALLET = RECIPIENT;
  process.env.RATE_LIMIT_SALT = "test-salt";
  delete process.env.REGISTRATION_FEE_SOL;
});

/** A confirmed transfer of `lamports` from PAYER to the receiving wallet. */
function transfer(lamports = 3_000_000, payer = PAYER): SolanaTransaction {
  return {
    slot: 1,
    blockTime: Math.floor((Date.now() - 60_000) / 1000),
    transaction: { message: { accountKeys: [{ pubkey: payer, signer: true }, { pubkey: RECIPIENT, signer: false }] } },
    meta: {
      err: null,
      preBalances: [1_000_000_000, 0],
      postBalances: [1_000_000_000 - lamports - 5_000, lamports],
    },
  };
}

const paid = (tx: SolanaTransaction) => async () => tx;

/**
 * A real Ed25519 key pair, so a link can be proved rather than only refused.
 * Same helper the oath tests use, for the same reason: a signature test whose
 * signatures are all invalid never exercises the accepting path.
 */
function keypair() {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const raw = publicKey.export({ format: "der", type: "spki" }).subarray(-32);
  return {
    address: base58Encode(new Uint8Array(raw)),
    sign: (message: string) =>
      base58Encode(new Uint8Array(signEd25519(null, Buffer.from(message, "utf8"), privateKey))),
  };
}

describe("registering", () => {
  it("registers the wallet the chain says paid, not one the caller names", async () => {
    // The request carries a signature and nothing else. Everything about who
    // paid comes off the transaction.
    const result = await register({
      signature: `sig-${randomUUID()}`,
      painterKey: "reg-1",
      fetchTransaction: paid(transfer()),
    });

    expect(result).toMatchObject({ ok: true, wallet: PAYER, alreadyRegistered: false });
    expect(await isRegistered(PAYER)).toBe(true);
    expect(await linkedWallet("reg-1")).toBe(PAYER);
  });

  it("stores what was actually paid, not what the fee currently is", async () => {
    // The fee is configuration and it will move. A row has to say what THIS
    // registration paid, or a change to the setting rewrites history.
    await register({
      signature: `sig-${randomUUID()}`,
      painterKey: "reg-2",
      fetchTransaction: paid(transfer(9_000_000)),
    });

    const [row] = await query<{ lamports: string }>(`SELECT lamports FROM registrations`);
    expect(row.lamports).toBe("9000000");
  });

  it("answers the same signature twice without registering twice", async () => {
    // A dropped response, a double click. The second call must not fail and
    // must not charge anything — and it still links, because the browser that
    // retries is usually the one that never got the first answer.
    const signature = `sig-${randomUUID()}`;
    const first = await register({ signature, painterKey: "reg-3", fetchTransaction: paid(transfer()) });
    const second = await register({ signature, painterKey: "reg-3b", fetchTransaction: paid(transfer()) });

    expect(first).toMatchObject({ ok: true, alreadyRegistered: false });
    expect(second).toMatchObject({ ok: true, wallet: PAYER, alreadyRegistered: true });
    expect((await query(`SELECT 1 FROM registrations`)).length).toBe(1);
    expect(await linkedWallet("reg-3b")).toBe(PAYER);
  });

  it("refuses a second payment from a wallet that already registered", async () => {
    // Permanent means permanent. Taking a second fee for it would be taking
    // money for nothing, so the answer says the transfer was not needed.
    await register({ signature: `sig-${randomUUID()}`, painterKey: "reg-4", fetchTransaction: paid(transfer()) });
    const again = await register({
      signature: `sig-${randomUUID()}`,
      painterKey: "reg-4",
      fetchTransaction: paid(transfer()),
    });

    expect(again).toMatchObject({ ok: false, reason: "already_registered" });
    if (again.ok) throw new Error("unreachable");
    expect(again.message).toContain("not been taken");
  });

  it("registers nobody when the transfer went somewhere else", async () => {
    const elsewhere: SolanaTransaction = {
      ...transfer(),
      transaction: {
        message: {
          accountKeys: [
            { pubkey: PAYER, signer: true },
            { pubkey: "SomeOtherWallet111111111111111111111111111", signer: false },
          ],
        },
      },
    };

    expect(await register({ signature: "sig-x", painterKey: "reg-5", fetchTransaction: paid(elsewhere) })).toMatchObject({
      ok: false,
      reason: "verification_failed",
    });
    expect((await query(`SELECT 1 FROM registrations`)).length).toBe(0);
  });

  it("registers nobody when the transfer was short", async () => {
    expect(
      await register({ signature: "sig-y", painterKey: "reg-6", fetchTransaction: paid(transfer(1_000)) }),
    ).toMatchObject({ ok: false, reason: "verification_failed" });
    expect(await linkedWallet("reg-6")).toBeNull();
  });

  it("refuses on a deployment with no receiving wallet rather than registering for free", async () => {
    const previous = process.env.PAYMENT_WALLET;
    delete process.env.PAYMENT_WALLET;
    try {
      expect(
        await register({ signature: "sig-z", painterKey: "reg-7", fetchTransaction: paid(transfer()) }),
      ).toMatchObject({ ok: false, reason: "not_configured" });
    } finally {
      process.env.PAYMENT_WALLET = previous;
    }
  });
});

describe("the paint gate", () => {
  it("refuses a painter with no registered wallet", { timeout: 20_000 }, async () => {
    const war = await makeWar({ width: 8, height: 8 });
    const token = await makeToken(war.id, 5);

    const result = await paintPixel({
      war, x: 1, y: 1, tokenId: token, colourSlot: 9,
      painterKey: "stranger", ipHash: "ip-s", subnetKey: "sub-s",
    });

    expect(result).toMatchObject({ ok: false, reason: "not_registered" });
    // Nothing written. An attempt that leaves a row behind is an attempt that
    // says the caller was here.
    expect((await query(`SELECT 1 FROM pixels`)).length).toBe(0);
    expect((await query(`SELECT 1 FROM paint_cooldowns`)).length).toBe(0);
  });

  it("lets the same painter paint once registered", { timeout: 20_000 }, async () => {
    const war = await makeWar({ width: 8, height: 8 });
    const token = await makeToken(war.id, 5);
    const input = {
      war, x: 1, y: 1, tokenId: token, colourSlot: 9,
      painterKey: "before-and-after", ipHash: "ip-b", subnetKey: "sub-b",
    };

    // The control: the same call, the same painter, one row apart. Without
    // the refusal above this test would pass against a gate that does nothing.
    expect(await paintPixel(input)).toMatchObject({ ok: false, reason: "not_registered" });
    await registerPainter("before-and-after");
    expect(await paintPixel(input)).toMatchObject({ ok: true, seq: 1 });
  });

  it("refuses a banned wallet that is registered", { timeout: 20_000 }, async () => {
    // The registration fee is the sybil price, so a ban has to bite the thing
    // that was paid for. Otherwise a ban is a ceremony: clear the cookie,
    // re-link the same wallet, carry on.
    const war = await makeWar({ width: 8, height: 8 });
    const token = await makeToken(war.id, 5);
    const wallet = await registerPainter("banned-painter");
    await banKey({ keyType: "wallet", key: wallet, reason: null, actor: "admin", expiresAt: null });

    expect(
      await paintPixel({
        war, x: 2, y: 2, tokenId: token, colourSlot: 9,
        painterKey: "banned-painter", ipHash: "ip-x", subnetKey: "sub-x",
      }),
    ).toMatchObject({ ok: false, reason: "banned" });
  });
});

describe("linking an existing registration to another browser", () => {
  it("links a browser that proves it controls a registered wallet", async () => {
    // The whole point of the two tables: a registration is permanent, a link
    // is not, and getting a new browser onto an old registration must cost
    // nothing. This is that path, end to end, with a real signature.
    const key = keypair();
    await register({
      signature: `sig-${randomUUID()}`,
      painterKey: "first-browser",
      fetchTransaction: paid(transfer(3_000_000, key.address)),
    });

    const challenge = await issueLinkChallenge();
    const result = await linkWallet({
      painterKey: "second-browser",
      wallet: key.address,
      nonce: challenge.nonce,
      signatureBase58: key.sign(challenge.message),
    });

    expect(result).toMatchObject({ ok: true, wallet: key.address });
    // Both browsers, one registration, one payment. A wallet is not unique in
    // painter_wallets precisely so a phone and a laptop are not two fees.
    expect(await linkedWallet("first-browser")).toBe(key.address);
    expect(await linkedWallet("second-browser")).toBe(key.address);
    expect((await query(`SELECT 1 FROM registrations`)).length).toBe(1);
  });

  it("refuses a signature that does not match the wallet", async () => {
    const wallet = await registerPainter("linked-elsewhere");
    const challenge = await issueLinkChallenge();

    const result = await linkWallet({
      painterKey: "new-browser",
      wallet,
      nonce: challenge.nonce,
      // 64 bytes of base58 that no key produced.
      signatureBase58: "5".repeat(88),
    });

    expect(result).toMatchObject({ ok: false, reason: "bad_signature" });
    expect(await linkedWallet("new-browser")).toBeNull();
  });

  it("burns the nonce even when the signature fails", async () => {
    // Spent before it is verified, like the oath: a replay that could keep
    // failing against a live nonce is a replay with unlimited attempts.
    const wallet = await registerPainter("burner");
    const challenge = await issueLinkChallenge();
    await linkWallet({ painterKey: "b2", wallet, nonce: challenge.nonce, signatureBase58: "5".repeat(88) });

    expect(
      await linkWallet({ painterKey: "b2", wallet, nonce: challenge.nonce, signatureBase58: "5".repeat(88) }),
    ).toMatchObject({ ok: false, reason: "nonce_spent" });
  });

  it("refuses an unknown nonce", async () => {
    const wallet = await registerPainter("unknown-nonce-painter");
    expect(
      await linkWallet({ painterKey: "u1", wallet, nonce: "never-issued", signatureBase58: "5".repeat(88) }),
    ).toMatchObject({ ok: false, reason: "unknown_nonce" });
  });

  it("will not accept an oath's nonce as a link", async () => {
    // Migration 013 opened `war_id` to NULL for link challenges, and the
    // comparison is strict in both directions: a nonce issued for a war
    // cannot be spent here.
    const war = await makeWar();
    const { issueOathChallenge } = await import("../oath");
    const oath = await issueOathChallenge({ warId: war.id, warSlug: war.slug, ticker: "T5" });
    const wallet = await registerPainter("oath-nonce-painter");

    expect(
      await linkWallet({ painterKey: "o1", wallet, nonce: oath.nonce, signatureBase58: "5".repeat(88) }),
    ).toMatchObject({ ok: false, reason: "wrong_war" });
  });

  it("registers on the signature alone when the fee is switched off", async () => {
    // The door in REGISTRATION_FEE_SOL, exercised. A door that is documented
    // but not wired is worse than no door: the operator reaches for it in the
    // one hour it matters and finds a screen asking for a transfer of zero.
    process.env.REGISTRATION_FEE_SOL = "0";
    try {
      const key = keypair();
      const challenge = await issueLinkChallenge();
      const result = await linkWallet({
        painterKey: "free-painter",
        wallet: key.address,
        nonce: challenge.nonce,
        signatureBase58: key.sign(challenge.message),
      });

      expect(result).toMatchObject({ ok: true, wallet: key.address });
      expect(await isRegistered(key.address)).toBe(true);
      const [row] = await query<{ lamports: string; signature: string }>(
        `SELECT lamports, signature FROM registrations WHERE wallet = $1`,
        [key.address],
      );
      // Nothing was paid, and the row says so rather than pretending.
      expect(row.lamports).toBe("0");
      expect(row.signature).toBe(`free:${key.address}`);
    } finally {
      delete process.env.REGISTRATION_FEE_SOL;
    }
  });

  it("still refuses an unregistered wallet when the fee is on", async () => {
    // The control for the test above: same call, same signature, one variable
    // apart. Without it, that test would pass against a link path that
    // registered anybody who signed.
    const key = keypair();
    const challenge = await issueLinkChallenge();
    const result = await linkWallet({
      painterKey: "paying-painter",
      wallet: key.address,
      nonce: challenge.nonce,
      signatureBase58: key.sign(challenge.message),
    });

    expect(result).toMatchObject({ ok: false, reason: "not_registered" });
    expect(await isRegistered(key.address)).toBe(false);
  });

  it("refuses a wallet that never registered, before spending anything", async () => {
    const challenge = await issueLinkChallenge();
    const result = await linkWallet({
      painterKey: "n1",
      wallet: PAYER,
      nonce: challenge.nonce,
      signatureBase58: "5".repeat(88),
    });
    // The signature is checked first, so this reports the signature. What
    // matters is that no link was made for an unregistered wallet.
    expect(result.ok).toBe(false);
    expect(await linkedWallet("n1")).toBeNull();
  });

  it("refuses a banned wallet without spending the nonce", async () => {
    const wallet = await registerPainter("banned-linker");
    await banKey({ keyType: "wallet", key: wallet, reason: null, actor: "admin", expiresAt: null });
    const challenge = await issueLinkChallenge();

    expect(
      await linkWallet({ painterKey: "bl", wallet, nonce: challenge.nonce, signatureBase58: "5".repeat(88) }),
    ).toMatchObject({ ok: false, reason: "banned" });

    // The nonce survived: a banned caller must not be able to burn challenges
    // other people are holding.
    const [row] = await query<{ used_at: Date | null }>(`SELECT used_at FROM oath_nonces WHERE nonce = $1`, [challenge.nonce]);
    expect(row.used_at).toBeNull();
  });
});

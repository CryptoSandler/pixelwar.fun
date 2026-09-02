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
  it("registers the wallet the chain says paid, and links nobody", async () => {
    // The request carries a signature and nothing else. Everything about who
    // paid comes off the transaction — and paying decides only that the
    // WALLET is registered, never which browser acts as it.
    const result = await register({ signature: `sig-${randomUUID()}`, fetchTransaction: paid(transfer()) });

    expect(result).toEqual({ ok: true, alreadyRegistered: false });
    expect(await isRegistered(PAYER)).toBe(true);
    expect((await query(`SELECT 1 FROM painter_wallets`)).length).toBe(0);
  });

  it("does not say whose wallet paid", async () => {
    // The result is exhaustive on purpose. A caller holding a signature —
    // which is public the moment the transfer lands — must not be able to
    // turn this endpoint into a lookup from payment to address.
    const result = await register({ signature: `sig-${randomUUID()}`, fetchTransaction: paid(transfer()) });
    expect(Object.keys(result).sort()).toEqual(["alreadyRegistered", "ok"]);
  });

  it("stores what was actually paid, not what the fee currently is", async () => {
    // The fee is configuration and it will move. A row has to say what THIS
    // registration paid, or a change to the setting rewrites history.
    await register({ signature: `sig-${randomUUID()}`, fetchTransaction: paid(transfer(9_000_000)) });

    const [row] = await query<{ lamports: string }>(`SELECT lamports FROM registrations`);
    expect(row.lamports).toBe("9000000");
  });

  it("answers the same signature twice without registering twice", async () => {
    // A dropped response, a double click. The second call must not fail and
    // must not charge anything.
    const signature = `sig-${randomUUID()}`;
    const first = await register({ signature, fetchTransaction: paid(transfer()) });
    const second = await register({ signature, fetchTransaction: paid(transfer()) });

    expect(first).toEqual({ ok: true, alreadyRegistered: false });
    expect(second).toEqual({ ok: true, alreadyRegistered: true });
    expect((await query(`SELECT 1 FROM registrations`)).length).toBe(1);
  });

  it("refuses a second payment from a wallet that already registered", async () => {
    // Permanent means permanent. Taking a second fee for it would be taking
    // money for nothing, so the answer says the transfer was not needed.
    await register({ signature: `sig-${randomUUID()}`, fetchTransaction: paid(transfer()) });
    const again = await register({ signature: `sig-${randomUUID()}`, fetchTransaction: paid(transfer()) });

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

    expect(await register({ signature: "sig-x", fetchTransaction: paid(elsewhere) })).toMatchObject({
      ok: false,
      reason: "verification_failed",
    });
    expect((await query(`SELECT 1 FROM registrations`)).length).toBe(0);
  });

  it("registers nobody when the transfer was short", async () => {
    expect(
      await register({ signature: "sig-y", fetchTransaction: paid(transfer(1_000)) }),
    ).toMatchObject({ ok: false, reason: "verification_failed" });
    expect(await isRegistered(PAYER)).toBe(false);
  });

  it("refuses on a deployment with no receiving wallet rather than registering for free", async () => {
    const previous = process.env.PAYMENT_WALLET;
    delete process.env.PAYMENT_WALLET;
    try {
      expect(
        await register({ signature: "sig-z", fetchTransaction: paid(transfer()) }),
      ).toMatchObject({ ok: false, reason: "not_configured" });
    } finally {
      process.env.PAYMENT_WALLET = previous;
    }
  });
});

describe("a USDC transfer to the shared wallet is not a registration", () => {
  /**
   * `PAYMENT_WALLET` is the address bidoor.lol collects on too — one wallet,
   * two products. Bidoor takes bids in USDC, which is an SPL transfer; this
   * verifier reads NATIVE lamports out of `preBalances`/`postBalances`. The
   * claim under test is that those are different enough that a bid cannot be
   * presented here as a registration fee.
   *
   * The test is written before anything is changed, because the answer
   * decides whether a reference key on the registration transfer is a
   * blocker for switching the fee on or merely an improvement to recovery.
   */
  const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";

  /**
   * What a bid actually looks like: USDC moves between token accounts, and
   * the only native lamports that move are the network fee, paid by the
   * bidder. `PAYMENT_WALLET`'s own SOL balance does not change — a token
   * account is a different account.
   */
  function usdcBid(options: { walletInKeys: boolean }): SolanaTransaction {
    const keys = [
      { pubkey: PAYER, signer: true },
      { pubkey: "BidderTokenAccount111111111111111111111111", signer: false },
      { pubkey: "RecipientTokenAccount1111111111111111111111", signer: false },
      ...(options.walletInKeys ? [{ pubkey: RECIPIENT, signer: false }] : []),
    ];
    return {
      slot: 1,
      blockTime: Math.floor((Date.now() - 60_000) / 1000),
      transaction: { message: { accountKeys: keys } },
      meta: {
        err: null,
        // 500 USDC arriving for the recipient — a large, real credit.
        preTokenBalances: [
          { accountIndex: 1, mint: USDC, owner: PAYER, uiTokenAmount: { amount: "500000000" } },
          { accountIndex: 2, mint: USDC, owner: RECIPIENT, uiTokenAmount: { amount: "0" } },
        ],
        postTokenBalances: [
          { accountIndex: 1, mint: USDC, owner: PAYER, uiTokenAmount: { amount: "0" } },
          { accountIndex: 2, mint: USDC, owner: RECIPIENT, uiTokenAmount: { amount: "500000000" } },
        ],
        // Native: only the bidder's fee leaves. Nothing reaches the wallet.
        preBalances: options.walletInKeys ? [1_000_000_000, 2_039_280, 2_039_280, 890_880] : [1_000_000_000, 2_039_280, 2_039_280],
        postBalances: options.walletInKeys ? [999_995_000, 2_039_280, 2_039_280, 890_880] : [999_995_000, 2_039_280, 2_039_280],
      },
    };
  }

  it("refuses a USDC bid whose accountKeys never mention the wallet", async () => {
    expect(
      await register({ signature: `sig-${randomUUID()}`, fetchTransaction: paid(usdcBid({ walletInKeys: false })) }),
    ).toMatchObject({ ok: false, reason: "verification_failed" });
    expect(await isRegistered(PAYER)).toBe(false);
  });

  it("refuses a USDC bid even when the wallet IS an account key", async () => {
    // The sharper case: the wallet appears in the transaction and the token
    // balances show 500 USDC credited to it. The native reader must still see
    // a lamport delta of zero and refuse, because token balances are not what
    // it reads and a fee denominated in SOL is not paid in USDC.
    const result = await register({
      signature: `sig-${randomUUID()}`,
      fetchTransaction: paid(usdcBid({ walletInKeys: true })),
    });
    expect(result).toMatchObject({ ok: false, reason: "verification_failed" });
    if (result.ok) throw new Error("unreachable");
    expect(result.message).toContain("did not send SOL");
    expect((await query(`SELECT 1 FROM registrations`)).length).toBe(0);
  });

  it("still accepts a real SOL transfer, so the refusals above are not a wall", async () => {
    // The control. Without it both tests pass against a verifier that refuses
    // everything, which is exactly the shape a broken verifier takes.
    expect(
      await register({ signature: `sig-${randomUUID()}`, fetchTransaction: paid(transfer()) }),
    ).toMatchObject({ ok: true });
  });
});

describe("a payment signature is not a credential", () => {
  /**
   * THE AUDIT'S FINDING C-1, kept as a test so it cannot come back.
   *
   * Every transfer to PAYMENT_WALLET is public the moment it lands, so the
   * signature is a string anybody can lift off a block explorer. It used to
   * be enough to bind the presenter's browser to the payer's wallet: paint on
   * somebody else's paid identity, and get them banned for it.
   */
  it("does not link the browser that presents somebody else's signature", async () => {
    const signature = `sig-${randomUUID()}`;

    // The victim pays. Their own browser is not linked by this either — it
    // links in the next step, by signing.
    expect(await register({ signature, fetchTransaction: paid(transfer()) })).toMatchObject({
      ok: true,
    });

    // The attacker holds only the public signature.
    const attacker = await register({ signature, fetchTransaction: paid(transfer()) });

    expect(attacker).toEqual({ ok: true, alreadyRegistered: true });
    expect((await query(`SELECT 1 FROM painter_wallets`)).length).toBe(0);
    expect(await linkedWallet("attacker-browser")).toBeNull();
  });

  it("does not link on a fresh signature either", { timeout: 20_000 }, async () => {
    // The variant that needs no explorer: watch the chain and present the
    // transfer BEFORE the payer's own browser does. The winner of that race
    // used to be the one who got linked.
    const signature = `sig-${randomUUID()}`;
    await register({ signature, fetchTransaction: paid(transfer()) });

    expect((await query(`SELECT 1 FROM painter_wallets`)).length).toBe(0);

    // And the attacker cannot paint with it.
    const war = await makeWar({ width: 100, height: 100 });
    const token = await makeToken(war.id, 5);
    expect(
      await paintPixel({
        war, x: 1, y: 1, tokenId: token, colourSlot: 9,
        painterKey: "attacker-browser", ipHash: "ip-att", subnetKey: "sub-att",
      }),
    ).toMatchObject({ ok: false, reason: "not_registered" });
  });

  it("leaves the wallet claimable by whoever can sign for it", async () => {
    // The other half, and the reason the refusals above are not just a wall:
    // the real payer still gets in, with the signature they can produce and
    // the attacker cannot.
    const key = keypair();
    const signature = `sig-${randomUUID()}`;
    await register({ signature, fetchTransaction: paid(transfer(3_000_000, key.address)) });

    const challenge = await issueLinkChallenge();
    expect(
      await linkWallet({
        painterKey: "the-payer",
        wallet: key.address,
        nonce: challenge.nonce,
        signatureBase58: key.sign(challenge.message),
      }),
    ).toMatchObject({ ok: true, wallet: key.address });
    expect(await linkedWallet("the-payer")).toBe(key.address);
  });
});

describe("the paint gate", () => {
  it("refuses a painter with no registered wallet", { timeout: 20_000 }, async () => {
    const war = await makeWar({ width: 100, height: 100 });
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
    const war = await makeWar({ width: 100, height: 100 });
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
    const war = await makeWar({ width: 100, height: 100 });
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
    await register({ signature: `sig-${randomUUID()}`, fetchTransaction: paid(transfer(3_000_000, key.address)) });

    // Two browsers, two signatures, one payment. The FIRST is not special
    // either: since the audit every link is proved the same way, including
    // the payer's own.
    const firstChallenge = await issueLinkChallenge();
    await linkWallet({
      painterKey: "first-browser",
      wallet: key.address,
      nonce: firstChallenge.nonce,
      signatureBase58: key.sign(firstChallenge.message),
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

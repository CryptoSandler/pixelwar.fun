import { generateKeyPairSync, sign as signEd25519 } from "node:crypto";
import { describe, expect, it } from "vitest";
import { base58Encode } from "../../base58";
import { makeToken, makeWar } from "../../canvas/__tests__/fixtures";
import { inspectPixel, banKey } from "../../moderation";
import { issueOathChallenge, swearOath } from "../oath";
import { paintPixel } from "../paint";

/**
 * A wallet can be banned, and that is the only ban that cannot be shed.
 *
 * A painter key is a cookie and an address rotates — banning either buys a
 * few minutes. A sworn wallet is bound for the war by `war_painters_wallet`,
 * and replacing it costs another token purchase. That is the whole argument
 * for why the sybil price here is the token and not a fee (DESIGN.md §1a),
 * and it only holds if moderation can actually name a wallet.
 */

const MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const holds = async () => 1_000n;

function wallet() {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const raw = publicKey.export({ format: "der", type: "spki" }).subarray(-32);
  return {
    address: base58Encode(new Uint8Array(raw)),
    sign: (m: string) =>
      base58Encode(new Uint8Array(signEd25519(null, Buffer.from(m, "utf8"), privateKey))),
  };
}

async function sworn(warId: string, warSlug: string, tokenId: string, painterKey: string) {
  const w = wallet();
  const challenge = await issueOathChallenge({ warId, warSlug, ticker: "T3" });
  const result = await swearOath({
    warId, warTokenId: tokenId, mint: MINT, painterKey,
    wallet: w.address, nonce: challenge.nonce,
    signatureBase58: w.sign(challenge.message), fetchHolding: holds,
  });
  expect(result.ok).toBe(true);
  return w;
}

describe("banning a wallet", () => {
  it("stops a sworn painter from painting", { timeout: 40_000 }, async () => {
    const war = await makeWar({ width: 8, height: 8, cooldownSeconds: 1 });
    const token = await makeToken(war.id, 3);
    const keys = { ipHash: "ip-wb1", subnetKey: "sn-wb1" };

    await paintPixel({ war, x: 0, y: 0, tokenId: token, colourSlot: 5, painterKey: "wb1", ...keys });
    const w = await sworn(war.id, war.slug, token, "wb1");

    await banKey({
      keyType: "wallet", key: w.address, reason: "test", actor: "admin",
      expiresAt: new Date(Date.now() + 3_600_000),
    });

    const after = await paintPixel({
      war, x: 3, y: 3, tokenId: token, colourSlot: 5, painterKey: "wb1",
      ipHash: "ip-wb1b", subnetKey: "sn-wb1b",
    });
    // A DIFFERENT address and subnet, same wallet. This is the case a painter
    // ban and an ip ban both miss.
    expect(after).toMatchObject({ ok: false, reason: "banned" });
  });

  it("does not stop a painter who never swore that wallet", { timeout: 40_000 }, async () => {
    const war = await makeWar({ width: 8, height: 8, cooldownSeconds: 1 });
    const token = await makeToken(war.id, 3);
    const stranger = wallet();

    await banKey({
      keyType: "wallet", key: stranger.address, reason: null, actor: "admin",
      expiresAt: new Date(Date.now() + 3_600_000),
    });

    const painted = await paintPixel({
      war, x: 1, y: 1, tokenId: token, colourSlot: 5,
      painterKey: "wb2", ipHash: "ip-wb2", subnetKey: "sn-wb2",
    });
    expect(painted.ok).toBe(true);
  });

  it("will not let a banned wallet swear itself back in", { timeout: 40_000 }, async () => {
    // Without this the ban is a ceremony: banning removes the badge, the
    // offender re-swears the same wallet and gets it back.
    const war = await makeWar({ width: 8, height: 8, cooldownSeconds: 1 });
    const token = await makeToken(war.id, 3);
    const w = wallet();

    await banKey({
      keyType: "wallet", key: w.address, reason: null, actor: "admin",
      expiresAt: new Date(Date.now() + 3_600_000),
    });

    const challenge = await issueOathChallenge({ warId: war.id, warSlug: war.slug, ticker: "T3" });
    const attempt = await swearOath({
      warId: war.id, warTokenId: token, mint: MINT, painterKey: "wb3",
      wallet: w.address, nonce: challenge.nonce,
      signatureBase58: w.sign(challenge.message), fetchHolding: holds,
    });

    expect(attempt).toMatchObject({ ok: false, reason: "banned" });
    if (attempt.ok) throw new Error("unreachable");
    // Says nothing about why or for how long.
    expect(attempt.message).not.toMatch(/ban|expires|until/i);
  });

  it("lets it back in once the ban expires", { timeout: 40_000 }, async () => {
    const war = await makeWar({ width: 8, height: 8, cooldownSeconds: 1 });
    const token = await makeToken(war.id, 3);
    const w = wallet();
    await banKey({
      keyType: "wallet", key: w.address, reason: null, actor: "admin",
      expiresAt: new Date(Date.now() - 1000),
    });

    const challenge = await issueOathChallenge({ warId: war.id, warSlug: war.slug, ticker: "T3" });
    expect(
      await swearOath({
        warId: war.id, warTokenId: token, mint: MINT, painterKey: "wb4",
        wallet: w.address, nonce: challenge.nonce,
        signatureBase58: w.sign(challenge.message), fetchHolding: holds,
      }),
    ).toMatchObject({ ok: true });
  });

  it("hands the operator the wallet when inspecting a sworn painter's pixel", { timeout: 40_000 }, async () => {
    const war = await makeWar({ width: 8, height: 8, cooldownSeconds: 1 });
    const token = await makeToken(war.id, 3);
    await paintPixel({
      war, x: 2, y: 0, tokenId: token, colourSlot: 5,
      painterKey: "wb5", ipHash: "ip-wb5", subnetKey: "sn-wb5",
    });
    const w = await sworn(war.id, war.slug, token, "wb5");

    // Sworn AFTER painting, which is why the wallet joins on the painter
    // rather than being stored on the pixel: the pixel cannot carry an answer
    // that was not true when it was painted.
    const found = await inspectPixel(war.id, 2, 0, 8);
    expect(found.current!.wallet).toBe(w.address);
  });

  it("reports no wallet for a recruit", { timeout: 40_000 }, async () => {
    const war = await makeWar({ width: 8, height: 8, cooldownSeconds: 1 });
    const token = await makeToken(war.id, 3);
    await paintPixel({
      war, x: 4, y: 0, tokenId: token, colourSlot: 5,
      painterKey: "wb6", ipHash: "ip-wb6", subnetKey: "sn-wb6",
    });

    const found = await inspectPixel(war.id, 4, 0, 8);
    // Null, not missing. Most painters are recruits and that is the volume,
    // not a lesser state.
    expect(found.current!.wallet).toBeNull();
  });
});

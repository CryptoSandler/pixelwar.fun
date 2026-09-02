import { beforeEach, describe, expect, it } from "vitest";
import { makeToken, makeWar, registerPainter } from "../../canvas/__tests__/fixtures";
import { query } from "../../db";
import { allegianceOf, armyCounts } from "../allegiance";
import { paintPixel } from "../paint";

/**
 * Every painter these tests use, registered before each one.
 *
 * Painting has needed a registered wallet since migration 012, and these are
 * unit tests of everything EXCEPT that gate — so the world they arrange is
 * one where the gate is satisfied. A key missing from this list fails loudly
 * with `not_registered` rather than quietly passing.
 */
const PAINTERS = ["a1", "a2", "b1", "p1", "p2", "p3", "p4", "p5", "p6"];

beforeEach(async () => {
  for (const key of PAINTERS) await registerPainter(key);
});


/**
 * A painter fights for one token per war.
 *
 * WHAT THIS REPLACES. `POST /api/paint` took a `tokenId` in the body of every
 * single pixel, so one person could paint for all twenty-four tokens in a
 * minute and every pixel was a free agent. A shared canvas where pixels
 * belong to nobody in particular is a mural; a war needs sides.
 *
 * WHAT IT DELIBERATELY IS NOT. `painter_key` is a signed cookie and clearing
 * it produces a painter with no allegiance. That is accepted rather than
 * fought — see migration 009 and DESIGN.md §1a. These tests assert a UX
 * commitment, not a security boundary, and none of them pretends the lock
 * cannot be shed.
 */

const KEYS = { ipHash: "ip-a", subnetKey: "subnet-a" };

describe("the first pixel commits a painter", () => {
  it("records the side and reports it back", { timeout: 30_000 }, async () => {
    const war = await makeWar({ width: 100, height: 100 });
    const alpha = await makeToken(war.id, 3);

    const painted = await paintPixel({
      war, x: 0, y: 0, tokenId: alpha, colourSlot: 7, painterKey: "p1", ...KEYS,
    });

    expect(painted).toMatchObject({ ok: true, allegianceTokenId: alpha });
    expect(await allegianceOf(war.id, "p1")).toMatchObject({ warTokenId: alpha, wallet: null });
  });

  it("refuses a later pixel for another token, and names the side", { timeout: 30_000 }, async () => {
    const war = await makeWar({ width: 100, height: 100 });
    const alpha = await makeToken(war.id, 3);
    const beta = await makeToken(war.id, 9);

    await paintPixel({ war, x: 0, y: 0, tokenId: alpha, colourSlot: 7, painterKey: "p2", ...KEYS });

    const defection = await paintPixel({
      war, x: 1, y: 1, tokenId: beta, colourSlot: 7, painterKey: "p2",
      ipHash: "ip-b", subnetKey: "subnet-b",
    });

    expect(defection).toMatchObject({ ok: false, reason: "wrong_allegiance" });
    if (defection.ok) throw new Error("unreachable");
    // Names the side rather than scolding, and says "this war" — NEVER
    // "permanent" or "irrevocable", because the lock is soft and copy
    // claiming otherwise would be the application lying about itself.
    // `makeToken` names a token T<slot>, so alpha at slot 3 is "T3". Asserted
    // exactly rather than loosely: the sentence IS the copy, and a looser
    // match would let it drift into the wording the design forbids.
    expect(defection.message).toBe("You fight for T3 this war.");
    expect(defection.message).not.toMatch(/permanent|irrevocable|forever|never/i);
  });

  it("leaves no pixel behind when it refuses", { timeout: 30_000 }, async () => {
    const war = await makeWar({ width: 100, height: 100 });
    const alpha = await makeToken(war.id, 3);
    const beta = await makeToken(war.id, 9);

    await paintPixel({ war, x: 0, y: 0, tokenId: alpha, colourSlot: 7, painterKey: "p3", ...KEYS });
    await paintPixel({
      war, x: 5, y: 5, tokenId: beta, colourSlot: 7, painterKey: "p3",
      ipHash: "ip-c", subnetKey: "subnet-c",
    });

    const pixels = await query<{ idx: number }>(`SELECT idx FROM pixels WHERE war_id = $1`, [war.id]);
    expect(pixels.map((p) => p.idx)).toEqual([0]);
  });

  it("lets the same painter keep painting for their own side", { timeout: 30_000 }, async () => {
    const war = await makeWar({ width: 100, height: 100, cooldownSeconds: 1 });
    const alpha = await makeToken(war.id, 3);

    await paintPixel({ war, x: 0, y: 0, tokenId: alpha, colourSlot: 7, painterKey: "p4", ...KEYS });
    const again = await paintPixel({
      war, x: 2, y: 2, tokenId: alpha, colourSlot: 20, painterKey: "p4",
      ipHash: "ip-d", subnetKey: "subnet-d",
    });

    // A different colour is fine — the palette is free and allegiance is not
    // about colour. Only the token has to match.
    expect(again).toMatchObject({ ok: true, colourSlot: 20, allegianceTokenId: alpha });
  });

  it("is per war, not per painter", { timeout: 30_000 }, async () => {
    const first = await makeWar({ width: 100, height: 100 });
    const second = await makeWar({ width: 100, height: 100 });
    const alphaFirst = await makeToken(first.id, 3);
    const betaSecond = await makeToken(second.id, 9);

    await paintPixel({ war: first, x: 0, y: 0, tokenId: alphaFirst, colourSlot: 7, painterKey: "p5", ...KEYS });
    const other = await paintPixel({
      war: second, x: 0, y: 0, tokenId: betaSecond, colourSlot: 7, painterKey: "p5",
      ipHash: "ip-e", subnetKey: "subnet-e",
    });

    // "One token per war" means exactly that. A new war is a new oath.
    expect(other).toMatchObject({ ok: true, allegianceTokenId: betaSecond });
  });

  it("survives two first pixels arriving together", { timeout: 30_000 }, async () => {
    // THE RACE the INSERT ... ON CONFLICT DO NOTHING RETURNING exists for.
    // SELECT-then-INSERT would have both paints find no row, both insert, and
    // the unique index report it as an error on the paint that did nothing
    // wrong. One of these two commits the allegiance; the other either agrees
    // with it or is refused — never crashes.
    const war = await makeWar({ width: 100, height: 100, cooldownSeconds: 1 });
    const alpha = await makeToken(war.id, 3);
    const beta = await makeToken(war.id, 9);

    const [a, b] = await Promise.all([
      paintPixel({ war, x: 0, y: 0, tokenId: alpha, colourSlot: 7, painterKey: "p6", ipHash: "ip-f", subnetKey: "subnet-f" }),
      paintPixel({ war, x: 1, y: 0, tokenId: beta, colourSlot: 7, painterKey: "p6", ipHash: "ip-g", subnetKey: "subnet-g" }),
    ]);

    const outcomes = [a, b];
    // Exactly one side won. Neither threw.
    const settled = await allegianceOf(war.id, "p6");
    expect(settled).not.toBeNull();
    expect([alpha, beta]).toContain(settled!.warTokenId);
    for (const outcome of outcomes) {
      if (!outcome.ok) expect(outcome.reason).toBe("wrong_allegiance");
    }
  });
});

describe("army counts", () => {
  it("counts painters per token, and sworn separately", { timeout: 30_000 }, async () => {
    const war = await makeWar({ width: 100, height: 100, cooldownSeconds: 1 });
    const alpha = await makeToken(war.id, 3);
    const beta = await makeToken(war.id, 9);

    await paintPixel({ war, x: 0, y: 0, tokenId: alpha, colourSlot: 7, painterKey: "a1", ipHash: "i1", subnetKey: "s1" });
    await paintPixel({ war, x: 1, y: 0, tokenId: alpha, colourSlot: 7, painterKey: "a2", ipHash: "i2", subnetKey: "s2" });
    await paintPixel({ war, x: 2, y: 0, tokenId: beta, colourSlot: 7, painterKey: "b1", ipHash: "i3", subnetKey: "s3" });

    const counts = await armyCounts(war.id);
    expect(counts.get(alpha)).toEqual({ painters: 2, sworn: 0 });
    expect(counts.get(beta)).toEqual({ painters: 1, sworn: 0 });
    // Nobody has sworn a wallet yet, and a recruit army is not a lesser
    // state — it is the volume a community's admission buys.
  });

  it("is empty for a war nobody has painted in", { timeout: 30_000 }, async () => {
    const war = await makeWar({ width: 100, height: 100 });
    expect((await armyCounts(war.id)).size).toBe(0);
  });
});

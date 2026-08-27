import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { execute } from "../../db";
import { makeWar } from "../../canvas/__tests__/fixtures";
import { advanceWar, reviveWar, warById } from "../lifecycle";
import { createWar, extendWar, moveStart } from "../operate";

/**
 * The operator's clocks, and the transition the state machine was missing.
 *
 * Until this batch a war could only come into being through
 * `scripts/seed-war.mts`, which meant running an event required a developer
 * at a terminal. That is the difference between a product and a demo, and it
 * was the highest-impact gap in the whole launch plan.
 */

const HOUR = 3_600_000;

describe("creating a war", () => {
  it("opens it scheduled, never live", { timeout: 30_000 }, async () => {
    const result = await createWar({
      slug: `w-${randomUUID().slice(0, 8)}`,
      title: "Fixture",
      entryPriceUsd: 25,
      cooldownSeconds: 30,
      startsAt: new Date(Date.now() + HOUR),
      endsAt: new Date(Date.now() + 3 * HOUR),
    });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    expect(result.value.status).toBe("scheduled");
  });

  it("stays scheduled even when its start is already past", { timeout: 30_000 }, async () => {
    // `advanceWar` is what turns a war live. Creating one already live would
    // be this function doing the state machine's job with none of its guards
    // — and the war becomes live on the first request that touches it, which
    // is the same moment it would have anyway.
    const result = await createWar({
      slug: `w-${randomUUID().slice(0, 8)}`,
      title: "Fixture",
      entryPriceUsd: 25,
      cooldownSeconds: 30,
      startsAt: new Date(Date.now() - HOUR),
      endsAt: new Date(Date.now() + HOUR),
    });
    if (!result.ok) throw new Error("unreachable");
    expect(result.value.status).toBe("scheduled");

    expect((await advanceWar(result.value)).status).toBe("live");
  });

  it("refuses a taken slug, a bad slug and a backwards window", { timeout: 30_000 }, async () => {
    const slug = `w-${randomUUID().slice(0, 8)}`;
    const base = {
      title: "Fixture", entryPriceUsd: 25, cooldownSeconds: 30,
      startsAt: new Date(Date.now() + HOUR), endsAt: new Date(Date.now() + 2 * HOUR),
    };
    expect((await createWar({ ...base, slug })).ok).toBe(true);
    expect(await createWar({ ...base, slug })).toMatchObject({ ok: false, reason: "slug_taken" });
    expect(await createWar({ ...base, slug: "NO CAPS" })).toMatchObject({ ok: false, reason: "bad_slug" });
    expect(
      await createWar({
        ...base, slug: `w-${randomUUID().slice(0, 8)}`,
        startsAt: new Date(Date.now() + 2 * HOUR), endsAt: new Date(Date.now() + HOUR),
      }),
    ).toMatchObject({ ok: false, reason: "bad_window" });
  });
});

describe("moving the opening", () => {
  it("starts a scheduled war now", { timeout: 30_000 }, async () => {
    // endsAt pushed out too: the fixture's default end is +1h, which would
    // equal the start being set here and violate CHECK (ends_at > starts_at).
    const war = await makeWar({
      status: "scheduled",
      startsAt: new Date(Date.now() + HOUR),
      endsAt: new Date(Date.now() + 4 * HOUR),
    });

    const result = await moveStart(war.id, new Date());

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    // "Start now" is a CLOCK move; the status is the state machine's answer
    // to it. `moveStart` advances only so the caller sees it immediately
    // rather than on whoever's next page load.
    expect(result.value.status).toBe("live");
  });

  it("refuses to move the opening of a war that is already live", { timeout: 30_000 }, async () => {
    const war = await makeWar({ status: "live" });
    expect(await moveStart(war.id, new Date())).toMatchObject({ ok: false, reason: "not_scheduled" });
  });
});

describe("extending", () => {
  it("pushes a live war's deadline out", { timeout: 30_000 }, async () => {
    const war = await makeWar({ status: "live", endsAt: new Date(Date.now() + HOUR) });
    const later = new Date(Date.now() + 5 * HOUR);

    const result = await extendWar(war.id, later);

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    expect(result.value.endsAt.getTime()).toBeCloseTo(later.getTime(), -3);
    expect(result.value.status).toBe("live");
  });

  it("revives an ended war and clears ended_at", { timeout: 30_000 }, async () => {
    // startsAt moves back with endsAt: the table has CHECK (ends_at >
    // starts_at) and the fixture's default start is an hour ago, so an
    // endsAt an hour ago describes a row the schema will not store.
    const war = await makeWar({
      status: "live",
      startsAt: new Date(Date.now() - 3 * HOUR),
      endsAt: new Date(Date.now() - HOUR),
    });
    await execute(`UPDATE wars SET status = 'ended', ended_at = now() WHERE id = $1`, [war.id]);

    const result = await extendWar(war.id, new Date(Date.now() + HOUR));

    expect(result.ok).toBe(true);
    const revived = await warById(war.id);
    expect(revived!.status).toBe("live");
    // `ended_at` means "when this war finished", and this war has not.
    expect(revived!.endedAt).toBeNull();
  });

  it("REFUSES a deadline already in the past", { timeout: 30_000 }, async () => {
    // Not tidiness. It is not an extension, it is a typo or a timezone;
    // allowing it makes a war flip straight back to ended on the next
    // request; and no capability is lost, because setting a live war's
    // deadline to the past IS "end it now" — which already exists with its
    // own name and a typed confirmation (`endWarNow`). Two routes to one
    // action, one deliberate and one accidental, is how a war gets switched
    // off by mistake.
    const war = await makeWar({ status: "live" });
    expect(await extendWar(war.id, new Date(Date.now() - 1000))).toMatchObject({
      ok: false, reason: "ends_in_the_past",
    });

    const ended = await makeWar({
      status: "live",
      startsAt: new Date(Date.now() - 3 * HOUR),
      endsAt: new Date(Date.now() - HOUR),
    });
    await execute(`UPDATE wars SET status = 'ended', ended_at = now() WHERE id = $1`, [ended.id]);
    expect(await reviveWar(ended.id, new Date(Date.now() - 1000))).toMatchObject({
      ok: false, reason: "ends_in_the_past",
    });
    // And it is still ended, untouched.
    expect((await warById(ended.id))!.status).toBe("ended");
  });

  it("refuses to revive a war that never ended", { timeout: 30_000 }, async () => {
    const war = await makeWar({ status: "live" });
    expect(await reviveWar(war.id, new Date(Date.now() + HOUR))).toMatchObject({
      ok: false, reason: "not_ended",
    });
  });
});

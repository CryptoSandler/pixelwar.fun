import { describe, expect, it } from "vitest";
import { execute } from "../../db";
import { advanceWar, currentWar, warBySlug } from "../lifecycle";

async function insertWar(overrides: {
  slug: string;
  status: string;
  startsAt: Date;
  endsAt: Date;
}): Promise<void> {
  await execute(
    `INSERT INTO wars (id, slug, title, status, entry_price_usd, entry_price_sol, cooldown_seconds, starts_at, ends_at)
     VALUES ($1, $1, 'Test war', $2, 25, 25000000, 30, $3, $4)`,
    [overrides.slug, overrides.status, overrides.startsAt, overrides.endsAt],
  );
}

const hoursFromNow = (h: number) => new Date(Date.now() + h * 3_600_000);

describe("war lifecycle", () => {
  it("reads a war back with its numbers as numbers", async () => {
    await insertWar({
      slug: "w1",
      status: "scheduled",
      startsAt: hoursFromNow(1),
      endsAt: hoursFromNow(49),
    });

    const war = await warBySlug("w1");
    expect(war).not.toBeNull();
    expect(war!.width).toBe(200);
    expect(war!.height).toBe(200);
    expect(war!.cooldownSeconds).toBe(30);
    expect(war!.lastSeq).toBe(0);
    // BIGINT comes back from pg as a string. Anything that forgets this ends
    // up comparing "10" < "9" and serving a diff that skips pixels.
    expect(typeof war!.lastSeq).toBe("number");
  });

  it("starts a scheduled war whose start time has passed", async () => {
    await insertWar({
      slug: "w2",
      status: "scheduled",
      startsAt: hoursFromNow(-1),
      endsAt: hoursFromNow(47),
    });

    const advanced = await advanceWar((await warBySlug("w2"))!);
    expect(advanced.status).toBe("live");
  });

  it("leaves a scheduled war alone before its start time", async () => {
    await insertWar({
      slug: "w3",
      status: "scheduled",
      startsAt: hoursFromNow(2),
      endsAt: hoursFromNow(50),
    });

    const advanced = await advanceWar((await warBySlug("w3"))!);
    expect(advanced.status).toBe("scheduled");
  });

  it("ends a live war whose end time has passed, and stamps ended_at", async () => {
    await insertWar({
      slug: "w4",
      status: "live",
      startsAt: hoursFromNow(-50),
      endsAt: hoursFromNow(-1),
    });

    const advanced = await advanceWar((await warBySlug("w4"))!);
    expect(advanced.status).toBe("ended");
    expect(advanced.endedAt).toBeInstanceOf(Date);
  });

  it("is idempotent when two callers close the same war at once", async () => {
    await insertWar({
      slug: "w5",
      status: "live",
      startsAt: hoursFromNow(-50),
      endsAt: hoursFromNow(-1),
    });
    const war = (await warBySlug("w5"))!;

    const [a, b] = await Promise.all([advanceWar(war), advanceWar(war)]);
    expect(a.status).toBe("ended");
    expect(b.status).toBe("ended");
    expect(a.endedAt!.getTime()).toBe(b.endedAt!.getTime());
  });

  it("returns the live war as the current one, advancing it on the way", async () => {
    await insertWar({
      slug: "w6",
      status: "scheduled",
      startsAt: hoursFromNow(-1),
      endsAt: hoursFromNow(47),
    });

    const current = await currentWar();
    expect(current!.slug).toBe("w6");
    expect(current!.status).toBe("live");
  });

  it("surfaces the next war when the running one's clock has just run out", async () => {
    // Wars run back to back, so the instant one ends is when the next one
    // matters most — and it is also when the most people are refreshing.
    // Looking at only the oldest candidate ends that war and reports that
    // there is nothing on, hiding the war queued behind it.
    await insertWar({
      slug: "expired",
      status: "live",
      startsAt: hoursFromNow(-50),
      endsAt: hoursFromNow(-1),
    });
    await insertWar({
      slug: "next-up",
      status: "scheduled",
      startsAt: hoursFromNow(2),
      endsAt: hoursFromNow(50),
    });

    const current = await currentWar();
    expect(current?.slug).toBe("next-up");
    expect((await warBySlug("expired"))!.status).toBe("ended");
  });

  it("has no current war once the only war has ended", async () => {
    await insertWar({
      slug: "w7",
      status: "live",
      startsAt: hoursFromNow(-50),
      endsAt: hoursFromNow(-1),
    });

    expect(await currentWar()).toBeNull();
  });
});

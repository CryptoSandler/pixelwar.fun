import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { execute } from "../../db";
import { UNMATCHED_ALERT_AGE_HOURS, unmatchedBacklog } from "../orphans";

/**
 * The pile, which nothing measured until now.
 *
 * `reconcile.yml` has warned since it was written when a pass FILES
 * something — and that is flow. A payment filed on Monday produced one
 * warning on Monday and silence forever after, so the only way to learn an
 * unresolved refund existed was for somebody to open /admin/orphans and
 * count, which is the thing nobody does until they already suspect.
 *
 * `already_settled` is the case that makes this matter: the order was paid by
 * a different payment, this payer's money is real, unmatched, and filed, and
 * they are owed a refund they do not know about.
 */

async function file(overrides: { hoursAgo?: number; status?: string } = {}) {
  const id = randomUUID();
  await execute(
    `INSERT INTO unmatched_payments
       (id, signature, received_base_units, expected_base_units, reason, created_at, status)
     VALUES ($1, $2, '25000000', '25000000', 'already_settled', now() - ($3 || ' hours')::interval, $4)`,
    [id, randomUUID(), String(overrides.hoursAgo ?? 0), overrides.status ?? "open"],
  );
  return id;
}

describe("the unmatched backlog", () => {
  it("is empty and calm when nothing is filed", { timeout: 30_000 }, async () => {
    expect(await unmatchedBacklog()).toMatchObject({
      open: 0,
      oldestFiledAt: null,
      oldestAgeHours: 0,
      stale: false,
    });
  });

  it("counts only what is still open", { timeout: 30_000 }, async () => {
    await file({ status: "open" });
    await file({ status: "applied" });
    await file({ status: "discarded" });

    // Applied and discarded are resolved: somebody looked and decided. They
    // are not a queue any more.
    expect((await unmatchedBacklog()).open).toBe(1);
  });

  it("reports the age of the OLDEST, not the newest", { timeout: 30_000 }, async () => {
    await file({ hoursAgo: 1 });
    await file({ hoursAgo: 40 });
    await file({ hoursAgo: 2 });

    const backlog = await unmatchedBacklog();
    // Ten filed this morning is a busy day; one filed two days ago is a
    // person who has been ignored. A count alone cannot tell those apart.
    expect(backlog.open).toBe(3);
    expect(backlog.oldestAgeHours).toBeGreaterThanOrEqual(40);
  });

  it("goes stale past the threshold, and not before", { timeout: 30_000 }, async () => {
    await file({ hoursAgo: UNMATCHED_ALERT_AGE_HOURS - 1 });
    expect((await unmatchedBacklog()).stale).toBe(false);

    await file({ hoursAgo: UNMATCHED_ALERT_AGE_HOURS + 1 });
    expect((await unmatchedBacklog()).stale).toBe(true);
  });

  it("is never stale with an empty queue, whatever the clock says", { timeout: 30_000 }, async () => {
    await file({ hoursAgo: 500, status: "applied" });
    const backlog = await unmatchedBacklog();
    expect(backlog.open).toBe(0);
    expect(backlog.stale).toBe(false);
  });
});

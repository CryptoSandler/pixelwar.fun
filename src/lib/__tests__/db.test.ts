import { describe, expect, it } from "vitest";
import { execute, query, transaction } from "../db";

describe("database harness", () => {
  it("is pointed at the test branch, not the app branch", async () => {
    // Neon names both branches' databases the same, so identity is proved by
    // the connection string the suite redirected DATABASE_URL to, not by the
    // database name.
    expect(process.env.DATABASE_URL).toBe(process.env.TEST_DATABASE_URL);
  });

  it("has applied the migrations", async () => {
    const rows = await query<{ version: string }>("SELECT version FROM schema_migrations");
    expect(rows.map((r) => r.version)).toContain("000_bootstrap");
  });

  it("rolls a transaction back when the work throws", async () => {
    await execute("INSERT INTO bootstrap_check (ok) VALUES (TRUE)");

    await expect(
      transaction(async (client) => {
        await client.query("INSERT INTO bootstrap_check (ok) VALUES (FALSE)");
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");

    const rows = await query<{ ok: boolean }>("SELECT ok FROM bootstrap_check");
    expect(rows).toHaveLength(1);
    expect(rows[0].ok).toBe(true);
  });

  it("truncates between tests, so the previous test's row is gone", async () => {
    expect(await query("SELECT 1 FROM bootstrap_check")).toHaveLength(0);
  });
});

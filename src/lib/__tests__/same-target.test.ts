import { describe, expect, it } from "vitest";
import { sameTarget } from "../../../vitest.setup";

// All values below are fake: no host, credential, or database name here is
// real, and none is derived from .env.local.
describe("sameTarget", () => {
  it("matches identical strings", () => {
    // The baseline case the naive `===` check already handled.
    expect(sameTarget("postgresql://u:p@host-a.example/db", "postgresql://u:p@host-a.example/db")).toBe(
      true,
    );
  });

  it("matches the same host and database when one has a trailing slash", () => {
    // A trailing slash on the path is spelling, not a different database.
    expect(sameTarget("postgresql://u:p@host-a.example/db", "postgresql://u:p@host-a.example/db/")).toBe(
      true,
    );
  });

  it("matches the same host in different letter case", () => {
    // DNS hostnames are case-insensitive; Host-A and host-a are one server.
    expect(sameTarget("postgresql://u:p@Host-A.example/db", "postgresql://u:p@host-a.example/db")).toBe(
      true,
    );
  });

  it("matches the same host and database with different credentials", () => {
    // Connecting as a different role still truncates the same tables.
    expect(
      sameTarget("postgresql://reader:pw1@host-a.example/db", "postgresql://writer:pw2@host-a.example/db"),
    ).toBe(true);
  });

  it("matches the same host and database with different query parameters", () => {
    // sslmode, channel_binding, and similar options don't change which
    // database gets truncated.
    expect(
      sameTarget(
        "postgresql://u:p@host-a.example/db?sslmode=require",
        "postgresql://u:p@host-a.example/db?sslmode=verify-full",
      ),
    ).toBe(true);
  });

  it("does not match genuinely different hosts", () => {
    // This is the case the guard exists to catch: two distinct databases.
    expect(sameTarget("postgresql://u:p@host-a.example/db", "postgresql://u:p@host-b.example/db")).toBe(
      false,
    );
  });

  it("does not match the same host with a different database name", () => {
    // One Neon project can host more than one database per branch; only the
    // full host+port+database identifies a single database.
    expect(sameTarget("postgresql://u:p@host-a.example/db-one", "postgresql://u:p@host-a.example/db-two")).toBe(
      false,
    );
  });

  it("matches an explicit :5432 against no port on the same host", () => {
    // 5432 is the Postgres default; omitting it is not a different port.
    expect(sameTarget("postgresql://u:p@host-a.example:5432/db", "postgresql://u:p@host-a.example/db")).toBe(
      true,
    );
  });

  it("fails closed when a string is not a parseable URL", () => {
    // We cannot tell what an unparseable string points at, so the safe
    // answer is to assume the worst and refuse to run rather than guess.
    expect(sameTarget("not-a-url", "postgresql://u:p@host-a.example/db")).toBe(true);
  });
});

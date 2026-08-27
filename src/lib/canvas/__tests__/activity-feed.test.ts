import { describe, expect, it } from "vitest";
import { leaderOf, toActivityEvents } from "../standings";

/**
 * The two pieces of the feed that are arithmetic rather than SQL, tested
 * without a database because they do not need one.
 */

describe("index to coordinates", () => {
  it("maps an index back to the cell it came from", () => {
    // The easy off-by-one: idx 0 is (0,0), and the last cell of a row is
    // (width-1, row) rather than (width, row).
    const events = toActivityEvents(
      [
        { seq: 1, idx: 0, colour_slot: 3, ticker: "A", painted_at: new Date() },
        { seq: 2, idx: 7, colour_slot: 3, ticker: "A", painted_at: new Date() },
        { seq: 3, idx: 8, colour_slot: 3, ticker: "A", painted_at: new Date() },
        { seq: 4, idx: 63, colour_slot: 3, ticker: "A", painted_at: new Date() },
      ],
      8,
    );

    expect(events.map((e) => [e.x, e.y])).toEqual([
      [0, 0],
      [7, 0],
      [0, 1],
      [7, 7],
    ]);
  });

  it("carries the sequence through as a number, whatever Postgres hands over", () => {
    // BIGINT arrives as a string from node-postgres, and a feed sorted by a
    // string sorts 10 before 9.
    const [event] = toActivityEvents(
      [{ seq: "12345", idx: 0, colour_slot: 1, ticker: "A", painted_at: new Date() }],
      8,
    );
    expect(event.seq).toBe(12345);
    expect(typeof event.seq).toBe("number");
  });
});

describe("the leader", () => {
  it("is the token holding the most, with its share of the board", () => {
    const leader = leaderOf([{ ticker: "A", owned: 30 }, { ticker: "B", owned: 70 }], 1000);
    expect(leader).toMatchObject({ ticker: "B", owned: 70 });
    expect(leader!.share).toBeCloseTo(7, 5);
  });

  it("is NULL when nobody holds anything", () => {
    // A distinct answer rather than a zero. "A leads with 0" is a headline
    // about nothing, and an empty board deserves its own words.
    expect(leaderOf([{ ticker: "A", owned: 0 }, { ticker: "B", owned: 0 }], 1000)).toBeNull();
    expect(leaderOf([], 1000)).toBeNull();
  });

  it("does not divide by a board with no cells", () => {
    expect(leaderOf([{ ticker: "A", owned: 5 }], 0)!.share).toBe(0);
  });
});

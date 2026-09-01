import { describe, expect, it } from "vitest";
import {
  LINK_SCALE,
  ZOOM_LIMITS,
  paramsForViewport,
  viewportFromParams,
} from "../viewport";

/**
 * The deep link, exhaustively.
 *
 * THIS IS THE ONLY INPUT TO THIS INTERFACE A STRANGER TYPES BY HAND. Every
 * other number in the client comes from a pointer event or from our own API;
 * `?x=&y=&z=` comes from a chat client that wrapped the URL, somebody
 * retyping it off a screenshot, a link to a board that has since been
 * resized, or somebody probing. So the table below is deliberately long: the
 * function has no DOM, no clock and no database in it, which means every one
 * of these costs microseconds and none of them has to be eyeballed.
 *
 * The rule it encodes, in one line: `x` and `y` are an address and are
 * strict; `z` is a preference and is forgiving.
 */

const BOARD = { width: 200, height: 200 };

describe("a link that names a place", () => {
  it("centres the addressed pixel, not its corner", () => {
    // The half-pixel matters at high zoom and is the same one
    // `openingViewport` adds. Without it a link lands on the boundary between
    // four cells and highlights the wrong one.
    expect(viewportFromParams({ x: "10", y: "20", z: "8" }, BOARD)).toEqual({
      centreX: 10.5,
      centreY: 20.5,
      scale: 8,
    });
  });

  it("accepts both edges of the board", () => {
    expect(viewportFromParams({ x: "0", y: "0" }, BOARD)).toMatchObject({ centreX: 0.5, centreY: 0.5 });
    expect(viewportFromParams({ x: "199", y: "199" }, BOARD)).toMatchObject({
      centreX: 199.5,
      centreY: 199.5,
    });
  });

  it("reads a decimal zoom", () => {
    expect(viewportFromParams({ x: "1", y: "1", z: "3.5" }, BOARD)?.scale).toBe(3.5);
  });
});

describe("addresses it refuses", () => {
  /**
   * Each of these yields null, and the caller then frames the board exactly as
   * it would with no link at all. Refusing rather than repairing is the point:
   * a link to a pixel that does not exist is not a weaker request, it is a
   * request about a different board.
   */
  const refused: Array<[string, { x?: string | null; y?: string | null }]> = [
    ["no params at all", {}],
    ["x without y", { x: "10" }],
    ["y without x", { y: "10" }],
    ["empty strings", { x: "", y: "" }],
    ["whitespace only", { x: "   ", y: "  " }],
    ["null", { x: null, y: null }],
    ["not a number", { x: "abc", y: "5" }],
    ["a fraction", { x: "10.5", y: "5" }],
    ["exponent notation", { x: "1e2", y: "5" }],
    ["hexadecimal", { x: "0x10", y: "5" }],
    ["a leading plus", { x: "+10", y: "5" }],
    ["Infinity", { x: "Infinity", y: "5" }],
    ["-Infinity", { x: "-Infinity", y: "5" }],
    ["NaN", { x: "NaN", y: "5" }],
    ["Arabic-Indic digits", { x: "١٢", y: "5" }],
    ["a comma pair in one param", { x: "10,20", y: "5" }],
    ["trailing junk", { x: "10px", y: "5" }],
    ["negative x", { x: "-1", y: "5" }],
    ["negative y", { x: "5", y: "-1" }],
    ["x one past the last column", { x: "200", y: "5" }],
    ["y one past the last row", { x: "5", y: "200" }],
    ["far off the board", { x: "999999", y: "999999" }],
    ["beyond safe integer range", { x: "9007199254740993", y: "5" }],
  ];

  for (const [name, params] of refused) {
    it(`refuses ${name}`, () => {
      expect(viewportFromParams(params, BOARD)).toBeNull();
    });
  }

  it("refuses an address that was on the board before it was resized", () => {
    // Boards are per war and wars are not all the same size. An old link to
    // (150, 150) on a 200x200 board must not open a 100x100 war anywhere.
    expect(viewportFromParams({ x: "150", y: "150" }, { width: 100, height: 100 })).toBeNull();
  });

  it("accepts a padded address, because a wrapped URL is not an attack", () => {
    // Chat clients wrap and mail clients pad. The value is still an integer
    // and still on the board, and refusing it would only punish the reader.
    expect(viewportFromParams({ x: " 10 ", y: "\t20" }, BOARD)).toMatchObject({ centreX: 10.5 });
  });
});

describe("zooms it forgives", () => {
  /**
   * A malformed `z` never costs somebody the place. Every case here keeps the
   * address and falls back, because the two params answer different
   * questions: "where" is the link, "how close" is a preference somebody's
   * URL bar may well have eaten.
   */
  const forgiven = [
    ["absent", undefined],
    ["null", null],
    ["empty", ""],
    ["whitespace", "  "],
    ["not a number", "close"],
    ["negative", "-4"],
    ["zero", "0"],
    ["exponent notation", "1e2"],
    ["NaN", "NaN"],
    ["Infinity", "Infinity"],
    ["a fraction with no leading digit", ".5"],
  ] as const;

  for (const [name, z] of forgiven) {
    it(`falls back to the default zoom when z is ${name}`, () => {
      const view = viewportFromParams({ x: "10", y: "20", z }, BOARD);
      expect(view).toMatchObject({ centreX: 10.5, centreY: 20.5, scale: LINK_SCALE });
    });
  }

  it("clamps a zoom below the minimum rather than refusing it", () => {
    expect(viewportFromParams({ x: "1", y: "1", z: "0.001" }, BOARD)?.scale).toBe(ZOOM_LIMITS.min);
  });

  it("clamps a zoom above the maximum to what a pinch can reach", () => {
    // The clamp uses the same ZOOM_LIMITS the gesture handlers do, so a link
    // cannot open at a zoom no gesture could produce and no gesture can
    // return to.
    expect(viewportFromParams({ x: "1", y: "1", z: "9999" }, BOARD)?.scale).toBe(ZOOM_LIMITS.max);
  });
});

describe("the link back to here", () => {
  it("names the cell at the centre of the view", () => {
    expect(paramsForViewport({ centreX: 10.5, centreY: 20.5, scale: 8 }, BOARD)).toEqual({
      x: "10",
      y: "20",
      z: "8",
    });
  });

  it("round-trips: parsing its own output returns the same view", () => {
    // The property that matters. Two people who pan to the same place get the
    // same URL, and that URL puts the next reader exactly where they were.
    for (const scale of [1, 3, 3.5, 12, 47.9, 48]) {
      for (const [cx, cy] of [
        [0.5, 0.5],
        [10.5, 20.5],
        [199.5, 199.5],
        [100.5, 3.5],
      ]) {
        const view = { centreX: cx, centreY: cy, scale };
        expect(viewportFromParams(paramsForViewport(view, BOARD), BOARD)).toEqual(view);
      }
    }
  });

  it("keeps a centre resting on the far edge inside the board", () => {
    // `clampToBoard` deliberately allows a centre of exactly `board.width`,
    // which is one past the last column. Serialising that unclamped would
    // produce a link this parser then refuses — a "copy link" button whose
    // own link does not work.
    const params = paramsForViewport({ centreX: 200, centreY: 200, scale: 4 }, BOARD);
    expect(params).toMatchObject({ x: "199", y: "199" });
    expect(viewportFromParams(params, BOARD)).not.toBeNull();
  });

  it("keeps a centre pushed off the near edge inside the board", () => {
    const params = paramsForViewport({ centreX: -5, centreY: -5, scale: 4 }, BOARD);
    expect(params).toMatchObject({ x: "0", y: "0" });
    expect(viewportFromParams(params, BOARD)).not.toBeNull();
  });

  it("does not put a trailing zero in a URL people paste into chat", () => {
    expect(paramsForViewport({ centreX: 1.5, centreY: 1.5, scale: 3 }, BOARD).z).toBe("3");
  });
});

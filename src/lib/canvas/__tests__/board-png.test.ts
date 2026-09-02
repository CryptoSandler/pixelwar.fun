import { crc32, inflateSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { encodeBoardPng, fitScale } from "../board-png";

/**
 * The encoder, checked by taking the file back apart.
 *
 * WHY THE FILE AND NOT A DECODER'S OPINION OF IT. There is no PNG decoder in
 * this project and adding one to test the encoder would mean trusting a second
 * implementation to agree about the thing being asserted. Walking the chunks
 * by hand is the stronger check anyway: it catches the failure that a decoder
 * reports as a single unhelpful "invalid PNG", which is a CRC computed over
 * the payload instead of over the type-plus-payload. That mistake produces a
 * file every viewer rejects, and produces it silently in dev because nothing
 * here looks at the image.
 */

/** A three-entry table: black, red, white. Alpha is present and ignored. */
const PALETTE = new Uint8ClampedArray([
  0, 0, 0, 255,
  255, 0, 0, 255,
  255, 255, 255, 255,
]);

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

type Chunk = { type: string; data: Buffer };

/** Walks a PNG, verifying every chunk's CRC as it goes. */
function chunksOf(png: Buffer): Chunk[] {
  expect(png.subarray(0, 8)).toEqual(SIGNATURE);

  const chunks: Chunk[] = [];
  let at = 8;
  while (at < png.length) {
    const length = png.readUInt32BE(at);
    const type = png.subarray(at + 4, at + 8).toString("ascii");
    const data = png.subarray(at + 8, at + 8 + length);
    const stated = png.readUInt32BE(at + 8 + length);

    // The CRC covers type AND data. Computing it over `data` alone is the
    // classic way to emit a file nothing will open.
    expect(crc32(png.subarray(at + 4, at + 8 + length))).toBe(stated);

    chunks.push({ type, data: Buffer.from(data) });
    at += 12 + length;
  }
  return chunks;
}

function chunk(png: Buffer, type: string): Buffer {
  const found = chunksOf(png).find((c) => c.type === type);
  if (!found) throw new Error(`No ${type} chunk in this PNG`);
  return found.data;
}

/** The decompressed scanlines, filter byte stripped from each row. */
function scanlines(png: Buffer, width: number): number[][] {
  const raw = inflateSync(chunk(png, "IDAT"));
  const rows: number[][] = [];
  for (let at = 0; at < raw.length; at += width + 1) {
    expect(raw[at]).toBe(0); // filter: none, on every row
    rows.push([...raw.subarray(at + 1, at + 1 + width)]);
  }
  return rows;
}

describe("encodeBoardPng", () => {
  it("writes a structurally valid PNG whose chunks are in order", () => {
    const { png } = encodeBoardPng(new Uint8Array([0, 1, 2, 0]), 2, 2, PALETTE);

    // THE CONTROL. Every other assertion in this file reads a chunk by name,
    // and `chunk()` throwing "no such chunk" looks the same whether the
    // encoder emitted nothing or emitted something unparseable. Asserting the
    // exact sequence means "the encoder is broken" and "the walk is broken"
    // fail differently.
    expect(chunksOf(png).map((c) => c.type)).toEqual(["IHDR", "PLTE", "IDAT", "IEND"]);
  });

  it("carries the palette as PLTE, alpha dropped", () => {
    const { png } = encodeBoardPng(new Uint8Array([0, 1, 2, 0]), 2, 2, PALETTE);
    expect([...chunk(png, "PLTE")]).toEqual([0, 0, 0, 255, 0, 0, 255, 255, 255]);
  });

  it("declares indexed colour at eight bits, uninterlaced", () => {
    const { png } = encodeBoardPng(new Uint8Array([0, 1, 2, 0]), 2, 2, PALETTE);
    const ihdr = chunk(png, "IHDR");
    expect(ihdr.readUInt32BE(0)).toBe(2);
    expect(ihdr.readUInt32BE(4)).toBe(2);
    expect(ihdr.readUInt8(8)).toBe(8);
    expect(ihdr.readUInt8(9)).toBe(3);
    expect(ihdr.readUInt8(12)).toBe(0);
  });

  it("writes the board's own bytes through, unchanged, at scale 1", () => {
    const { png, width, height } = encodeBoardPng(
      new Uint8Array([0, 1, 2, 0]), 2, 2, PALETTE,
    );
    expect([width, height]).toEqual([2, 2]);
    expect(scanlines(png, 2)).toEqual([
      [0, 1],
      [2, 0],
    ]);
  });

  /**
   * The reason the scale exists. A viewer that resamples turns the grid — the
   * entire subject — into a blur, so the nearest-neighbour result is made a
   * property of the file and nothing downstream gets a vote.
   */
  it("repeats every pixel in both directions at scale 3", () => {
    const { png, width, height } = encodeBoardPng(
      new Uint8Array([0, 1, 2, 0]), 2, 2, PALETTE, 3,
    );
    expect([width, height]).toEqual([6, 6]);
    expect(scanlines(png, 6)).toEqual([
      [0, 0, 0, 1, 1, 1],
      [0, 0, 0, 1, 1, 1],
      [0, 0, 0, 1, 1, 1],
      [2, 2, 2, 0, 0, 0],
      [2, 2, 2, 0, 0, 0],
      [2, 2, 2, 0, 0, 0],
    ]);
  });

  /**
   * The same policy `BoardImage.setBase` applies, for the same reason: a byte
   * the palette cannot name has no honest colour, and rendering it as a stale
   * one is a picture that lies rather than a picture with a hole in it.
   */
  it("degrades a slot the palette cannot name to unpainted", () => {
    const { png } = encodeBoardPng(new Uint8Array([9, 1, 2, 200]), 2, 2, PALETTE);
    expect(scanlines(png, 2)).toEqual([
      [0, 1],
      [2, 0],
    ]);
  });

  it("refuses a byte count that is not the board", () => {
    expect(() => encodeBoardPng(new Uint8Array(3), 2, 2, PALETTE)).toThrow(/expected 4 bytes/);
  });

  it("refuses a fractional or zero scale", () => {
    expect(() => encodeBoardPng(new Uint8Array(4), 2, 2, PALETTE, 1.5)).toThrow(RangeError);
    expect(() => encodeBoardPng(new Uint8Array(4), 2, 2, PALETTE, 0)).toThrow(RangeError);
  });
});

describe("fitScale", () => {
  it("takes the largest whole multiple that fits the box", () => {
    expect(fitScale(200, 200, 470)).toBe(2);
    expect(fitScale(100, 100, 470)).toBe(4);
    expect(fitScale(200, 200, 600)).toBe(3);
  });

  /**
   * A board bigger than its box comes back at 1 and overflows, rather than
   * coming back fractional. Unequal cells read as a grid with a stutter in
   * it, which is worse than a board that does not fit.
   */
  it("never goes below 1, and never returns a fraction", () => {
    expect(fitScale(1000, 1000, 470)).toBe(1);
    expect(Number.isInteger(fitScale(300, 300, 470))).toBe(true);
  });

  /** The long side decides, so a wide war is not cropped by a tall box. */
  it("fits the longest side", () => {
    expect(fitScale(400, 100, 400)).toBe(1);
  });
});

import { crc32, deflateSync } from "node:zlib";

/**
 * The board as a PNG, encoded here rather than drawn by anything.
 *
 * WHY THIS EXISTS AT ALL. `BoardImage` next door turns the same bytes into an
 * RGBA buffer for a `<canvas>`, and that is the whole rendering story in the
 * browser. A share image has to exist on the SERVER, where there is no canvas
 * and no DOM, and it has to exist as a file a crawler can fetch — so the
 * pixels have to become a PNG somewhere. This is that somewhere.
 *
 * WHY IT IS HAND-ROLLED, WHICH LOOKS LIKE THE EXPENSIVE CHOICE AND IS NOT.
 * The board is an INDEXED image by construction: a byte per pixel, and a
 * palette table that already exists in `palette.ts`. That is precisely PNG's
 * colour type 3, so the encoding is the identity function plus a header — the
 * bytes go in unchanged. `node:zlib` supplies both halves that would otherwise
 * be worth a dependency: `deflateSync` produces exactly the zlib stream IDAT
 * wants, and `crc32` is the chunk checksum, so there is no CRC table to write
 * and get wrong. An image library would arrive to re-encode a buffer we
 * already hold in the target format.
 *
 * THE SCALE IS BAKED IN RATHER THAN APPLIED BY THE VIEWER, and this is the
 * part that is a decision rather than plumbing. A 200x200 PNG displayed at
 * 400px is resampled by whatever is drawing it, and every renderer worth
 * worrying about — Satori, a browser without `image-rendering: pixelated`, a
 * social preview card — smooths it. A smoothed pixel board is not a smaller
 * pixel board, it is a photograph of one: the grid, which is the entire
 * subject, turns to mush. Writing each source pixel `scale` times across and
 * `scale` rows down makes the nearest-neighbour result a property of the FILE,
 * so nothing downstream gets a vote. It costs `scale^2` bytes before deflate
 * and almost nothing after, because the duplicated runs are exactly what
 * deflate is good at.
 */

/** PNG's fixed 8-byte signature. */
const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/**
 * Colour type 3: each pixel is an index into PLTE. The one PNG mode that can
 * take this board's bytes without transforming them.
 */
const COLOUR_TYPE_INDEXED = 3;

/**
 * A PNG chunk: length, type, data, CRC of (type + data).
 *
 * The CRC covers the type as well as the payload — a detail that produces a
 * file every viewer rejects if it is got wrong, and produces it silently.
 */
function chunk(type: string, data: Buffer): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const typed = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const check = Buffer.alloc(4);
  check.writeUInt32BE(crc32(typed), 0);
  return Buffer.concat([length, typed, check]);
}

export type BoardPng = { png: Buffer; width: number; height: number };

/**
 * Encodes `bytes` — one palette slot per pixel, row-major — as an indexed PNG.
 *
 * `palette` is the slot-indexed RGBA table the byte is read against, the same
 * argument `BoardImage` takes and for the same reason: the colour layer and
 * the territory layer disagree about what a byte MEANS, and a function that
 * guessed would silently mis-colour one of them. Alpha is dropped, because
 * every entry in both tables is opaque and a `tRNS` chunk that says so is a
 * chunk that can drift from the table it describes.
 *
 * A slot the palette cannot name is written as 0 (unpainted), matching
 * `BoardImage.setBase` exactly: a corrupt board degrades to holes rather than
 * to a stale colour that lies about what is there.
 */
export function encodeBoardPng(
  bytes: Uint8Array,
  width: number,
  height: number,
  palette: Uint8ClampedArray,
  scale = 1,
): BoardPng {
  if (!Number.isInteger(scale) || scale < 1) {
    throw new RangeError(`Scale must be a positive integer, got ${scale}`);
  }
  if (bytes.length !== width * height) {
    throw new Error(`Board is ${width}x${height}: expected ${width * height} bytes, got ${bytes.length}`);
  }

  const entries = Math.floor(palette.length / 4);
  if (entries < 1 || entries > 256) {
    throw new RangeError(`A PLTE holds 1..256 entries, got ${entries}`);
  }

  const outWidth = width * scale;
  const outHeight = height * scale;

  const header = Buffer.alloc(13);
  header.writeUInt32BE(outWidth, 0);
  header.writeUInt32BE(outHeight, 4);
  header.writeUInt8(8, 8); // bit depth: one byte per index
  header.writeUInt8(COLOUR_TYPE_INDEXED, 9);
  header.writeUInt8(0, 10); // compression: deflate, the only value PNG defines
  header.writeUInt8(0, 11); // filter method: the only value PNG defines
  header.writeUInt8(0, 12); // interlace: none

  const plte = Buffer.alloc(entries * 3);
  for (let slot = 0; slot < entries; slot++) {
    plte[slot * 3] = palette[slot * 4];
    plte[slot * 3 + 1] = palette[slot * 4 + 1];
    plte[slot * 3 + 2] = palette[slot * 4 + 2];
  }

  /*
   * Scanlines, each prefixed with its filter byte.
   *
   * FILTER 0 (NONE) ON EVERY ROW, deliberately. The adaptive filters PNG
   * offers predict a pixel from its neighbours and store the difference, which
   * pays on photographs and costs on this: an index is not a magnitude, so
   * subtracting one palette slot from another produces noise where flat runs
   * of an identical byte were. Deflate compresses those runs directly and the
   * filters would be spending bytes to hide them.
   */
  const stride = outWidth + 1;
  const raw = Buffer.alloc(stride * outHeight);

  for (let y = 0; y < height; y++) {
    // Build one source row expanded horizontally, then repeat it `scale`
    // times. The vertical repeat is a memory copy rather than a second pass
    // over the palette lookup, which is the only part of this that is not
    // trivially cheap.
    const rowStart = y * scale * stride;
    raw[rowStart] = 0; // filter: none
    for (let x = 0; x < width; x++) {
      const slot = bytes[y * width + x];
      const value = slot < entries ? slot : 0;
      raw.fill(value, rowStart + 1 + x * scale, rowStart + 1 + (x + 1) * scale);
    }
    for (let repeat = 1; repeat < scale; repeat++) {
      raw.copy(raw, rowStart + repeat * stride, rowStart, rowStart + stride);
    }
  }

  const png = Buffer.concat([
    SIGNATURE,
    chunk("IHDR", header),
    chunk("PLTE", plte),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);

  return { png, width: outWidth, height: outHeight };
}

/**
 * The largest whole-number scale that fits a board inside `box` pixels.
 *
 * WHOLE NUMBERS ONLY, and never below 1. A fractional scale reintroduces
 * exactly the resampling this module exists to prevent — 200 pixels drawn
 * across 470 puts some board pixels at two screen pixels and some at three,
 * which reads as a grid with a stutter in it. Better a board that does not
 * fill its box than one whose cells are unequal, so a board too large for the
 * box comes back at 1 and is left to overflow rather than being smeared.
 */
export function fitScale(width: number, height: number, box: number): number {
  return Math.max(1, Math.floor(box / Math.max(width, height)));
}

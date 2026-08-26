import { rgba } from "../wars/palette";

/**
 * The board as pixels, kept as two parallel buffers: the palette slot per
 * pixel, and the RGBA the browser actually blits.
 *
 * Slots are kept because the RGBA cannot be read back reliably — two slots
 * could in principle share a colour — and because inspecting a pixel needs the
 * slot, not the colour.
 *
 * No DOM here. The React layer wraps `rgbaBuffer` in an ImageData and draws it;
 * everything that can be got wrong lives in this file, where it is testable.
 */
export class BoardImage {
  readonly slots: Uint8Array;
  readonly rgbaBuffer: Uint8ClampedArray;
  private readonly palette: Uint8ClampedArray;

  /**
   * `palette` decides what a byte MEANS, and the two layers disagree about
   * that — the colour layer's bytes are painted colours (0..24), the
   * territory layer's are owning token slots (0..255). Passing the wrong
   * table does not throw; it silently blanks every pixel the table cannot
   * name, because `isKnownSlot` degrades an unrenderable byte to unpainted.
   * That is the right policy for a corrupt board and the wrong one for a
   * layer mismatch, which is why the table is an argument rather than
   * something this class guesses.
   */
  constructor(
    readonly width: number,
    readonly height: number,
    palette: Uint8ClampedArray = rgba(),
  ) {
    this.palette = palette;
    this.slots = new Uint8Array(width * height);
    this.rgbaBuffer = new Uint8ClampedArray(width * height * 4);
    this.repaintAll();
  }

  setBase(bytes: Uint8Array): void {
    if (bytes.length !== this.slots.length) {
      throw new Error(`Board is ${this.width}x${this.height}: expected ${this.slots.length} bytes, got ${bytes.length}`);
    }
    for (let idx = 0; idx < bytes.length; idx++) {
      // Replace unrenderable bytes with 0 (unpainted). A slot outside the
      // palette would produce a stale colour in the RGBA buffer while the slots
      // array claims otherwise. A corrupt board degrades to holes, not lies.
      this.slots[idx] = this.isKnownSlot(bytes[idx]) ? bytes[idx] : 0;
    }
    this.repaintAll();
  }

  applyChange(idx: number, slot: number): void {
    if (idx < 0 || idx >= this.slots.length) return;
    // Drop changes to unrenderable slots. Writing the slot but failing the
    // palette lookup would leave the pixel showing its old colour while slotAt()
    // claims otherwise: a canvas that lies rather than one with a hole in it.
    if (!this.isKnownSlot(slot)) return;
    this.slots[idx] = slot;
    this.paintOne(idx);
  }

  slotAt(idx: number): number {
    return this.slots[idx] ?? 0;
  }

  /**
   * Derived from the palette table this instance was given, not from
   * `PALETTE_SIZE`. Hard-coding the palette's own size here was correct while
   * a byte could only ever be a painted colour; it would now silently blank
   * every territory pixel owned by a token past the 24th, because that table
   * is 256 entries long and this test would still stop at 24.
   */
  private isKnownSlot(slot: number): boolean {
    return Number.isInteger(slot) && slot >= 0 && slot < this.palette.length / 4;
  }

  private repaintAll(): void {
    for (let idx = 0; idx < this.slots.length; idx++) this.paintOne(idx);
  }

  private paintOne(idx: number): void {
    const offset = this.slots[idx] * 4;
    this.rgbaBuffer.set(this.palette.subarray(offset, offset + 4), idx * 4);
  }
}

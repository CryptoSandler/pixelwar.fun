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
  private readonly palette = rgba();

  constructor(
    readonly width: number,
    readonly height: number,
  ) {
    this.slots = new Uint8Array(width * height);
    this.rgbaBuffer = new Uint8ClampedArray(width * height * 4);
    this.repaintAll();
  }

  setBase(bytes: Uint8Array): void {
    if (bytes.length !== this.slots.length) {
      throw new Error(`Board is ${this.width}x${this.height}: expected ${this.slots.length} bytes, got ${bytes.length}`);
    }
    this.slots.set(bytes);
    this.repaintAll();
  }

  applyChange(idx: number, slot: number): void {
    if (idx < 0 || idx >= this.slots.length) return;
    this.slots[idx] = slot;
    this.paintOne(idx);
  }

  slotAt(idx: number): number {
    return this.slots[idx] ?? 0;
  }

  private repaintAll(): void {
    for (let idx = 0; idx < this.slots.length; idx++) this.paintOne(idx);
  }

  private paintOne(idx: number): void {
    const offset = this.slots[idx] * 4;
    this.rgbaBuffer.set(this.palette.subarray(offset, offset + 4), idx * 4);
  }
}

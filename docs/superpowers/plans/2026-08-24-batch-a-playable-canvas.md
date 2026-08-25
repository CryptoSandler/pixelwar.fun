# Batch A — Playable Canvas Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A war you can open in a local browser, paint on with a working cooldown, and watch update in a second tab — with no payments, no wallet, and no admin.

**Architecture:** Next.js App Router over Postgres, no ORM. The canvas is one byte per pixel in a `pixels` table keyed by `(war_id, idx)`; every paint allocates a gapless sequence number from the war row inside the same transaction, which is what makes `/api/diff?since=` safe to poll. The browser fetches the full board once as binary and then polls a small JSON diff every 1.5 s. All coordinate maths and all pixel-buffer maths live in pure modules with unit tests; React is a thin shell over them.

**Tech Stack:** Next 16.3.2, React 19.2.8, TypeScript, Tailwind v4, `pg`, vitest 4, tsx, Neon Postgres.

**Spec:** [`docs/superpowers/specs/2026-08-24-pixelwar-design.md`](../specs/2026-08-24-pixelwar-design.md)

## Global Constraints

- **Every string in the repo is English** — code, comments, commits, docs, UI copy. No Spanish anywhere.
- **The author is CryptoSandler, and nobody else.** This repo is public, and no other name, handle, or personal detail belongs in a commit, a file, or a comment. `git config user.name` and `user.email` are already set here; do not override them, and do not let a tool add a co-author or a machine username. Check with `git log --format='%an <%ae>'` before pushing.
- **No code, assets, sounds, copy, or palette values are taken from `rplacelive/game`.** It is LGPL-3.0 with a non-commercial request and this product charges money. Ideas only. See [`docs/references.md`](../../references.md).
- **Reuse bidoor, do not rewrite it.** Modules named as "copy from bidoor" are copied from `~/proyectos/outbid-tokens` and adapted, not reimplemented from memory.
- **`SITE_URL` is `https://pixelwar.fun`.**
- **No ORM.** Parameterised `pg` queries only; never string-interpolate a value into SQL.
- **The database is Neon, and there is no local Postgres.** Branch `production` is the app database (`DATABASE_URL`); branch `tests` is a disposable copy the suite truncates (`TEST_DATABASE_URL`). Both strings use `sslmode=verify-full`. Both strings live in `.env.local` and nowhere else — not in `.env.example`, not in a commit, not in a comment, not in a shell history you paste into a report.
- **Canvas is 200×200.** Palette slot `0` is unpainted and renders as `#2E2E38`; slots `1`–`24` are token colours.
- **Required env vars have no defaults.** A missing `DATABASE_URL`, `RATE_LIMIT_SALT` or `PAINTER_COOKIE_SECRET` is a startup failure, not a fallback.
- **This is Next 16, not the Next in your training data.** Before writing any route handler or page, read the relevant guide under `node_modules/next/dist/docs/`. The `AGENTS.md` block Next writes into the repo stays committed.
- **TDD.** Test first, watch it fail, implement minimally, watch it pass, commit.

---

## File Structure

```
migrations/001_initial.sql       Batch A tables only
scripts/migrate.mts              Migration runner; --test targets TEST_DATABASE_URL
migrations/000_bootstrap.sql     A table for the harness to assert on
scripts/seed-war.mts             Demo war with six tokens, development only

src/lib/db.ts                    Pool, query, transaction (copied from bidoor)
src/lib/config.ts                Env readers that throw rather than default

src/lib/wars/palette.ts          The 24 colours, the ground, RGBA lookup
src/lib/wars/lifecycle.ts        Row type, currentWar(), advanceWar()

src/lib/paint/painter.ts         Signed painter cookie, painter key derivation
src/lib/paint/client-ip.ts       clientIp + hashIp (copied from bidoor), subnetKey
src/lib/paint/paint.ts           paintPixel() — the whole transaction
src/lib/paint/bans.ts            isBanned()

src/lib/canvas/state.ts          canvasBytes(): full board + seq
src/lib/canvas/diff.ts           changesSince(): diff or resync
src/lib/canvas/board-image.ts    Slots -> RGBA buffer, pure
src/lib/canvas/viewport.ts       Zoom/pan maths, screen<->board, pure

src/app/api/session/route.ts     Issues the painter cookie
src/app/api/canvas/route.ts      Binary board
src/app/api/diff/route.ts        JSON diff
src/app/api/paint/route.ts       Paint one pixel
src/app/api/leaderboard/route.ts Counts per token

src/app/page.tsx                 The war page
src/components/Board.tsx         Canvas element, pointer handling, rendering
src/components/TokenRail.tsx     Token picker
src/components/PaintButton.tsx   The button that is also the cooldown timer
src/components/WarHud.tsx        Coordinates, zoom, time remaining
src/hooks/useCanvasStream.ts     Fetch board, poll diff, expose slots
```

`canvas/` answers "what does the board look like", `paint/` answers "may this
person paint", `wars/` answers "what state is the war in". Each is testable
without the other two, which is why they are separate directories rather than
one `lib/game.ts`.

---

### Task 1: Scaffold, the test harness, and the palette

**Files:**
- Create: `package.json`, `tsconfig.json`, `next.config.ts`, `postcss.config.mjs`, `eslint.config.mjs`, `.gitignore`, `vitest.config.mts`, `src/app/layout.tsx`, `src/app/page.tsx`, `src/app/globals.css`, `src/lib/wars/palette.ts`
- Test: `src/lib/wars/__tests__/palette.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: a working `npm test`, `npm run lint` and `npm run build`; and from `src/lib/wars/palette.ts`: `PALETTE: readonly string[]` (24 entries, array index 0 is colour slot 1), `CANVAS_GROUND: string`, `PALETTE_SIZE: 24`, `colourForSlot(slot: number): string`, `toRgb(hex: string): [number, number, number]`, `rgbDistance(a: string, b: string): number`, `rgba(): Uint8ClampedArray` (25 x 4 bytes, slot-indexed).

**No database.** Nothing in this task connects to Postgres. The database
arrives in Task 4, and the harness for it with it.

- [ ] **Step 1: Scaffold the Next app**

```bash
cd ~/proyectos/pixelwar
npx create-next-app@16.3.2 . --typescript --tailwind --eslint --app --src-dir --no-import-alias --use-npm
npm install -D tsx vitest@^4 dotenv
```

Keep the existing `README.md` and `docs/`. If the generator refuses to run in
a non-empty directory, scaffold into `/tmp/pw` and copy everything except
`README.md` and `docs/` across.

- [ ] **Step 2: Read the Next 16 docs before writing anything**

```bash
ls node_modules/next/dist/docs/
```

Read the App Router guide there. This version differs from what you remember;
the guides in `node_modules` are authoritative, not your recollection. Commit
the `AGENTS.md` block Next generates into the repo.

- [ ] **Step 3: Add the scripts**

In `package.json`:

```json
{
  "scripts": {
    "dev": "next dev",
    "build": "next build",
    "start": "next start",
    "lint": "eslint",
    "test": "vitest run",
    "test:watch": "vitest"
  }
}
```

- [ ] **Step 4: Configure vitest**

Create `vitest.config.mts`:

```ts
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    setupFiles: ["./vitest.setup.ts"],
    // One worker. Later tasks add tests that truncate shared tables, and
    // running files in parallel would have them delete each other's fixtures
    // mid-assertion.
    //
    // Vitest 4 removed `poolOptions.forks.singleFork`; `fileParallelism: false`
    // is its top-level replacement.
    pool: "forks",
    fileParallelism: false,
  },
});
```

Create `vitest.setup.ts`. It only loads the environment for now; Task 4 adds
the database guards to this same file:

```ts
import { config } from "dotenv";

config({ path: ".env.local" });
```

- [ ] **Step 5: Confirm `.gitignore` covers the secrets**

`.env*.local` and `node_modules` must be ignored. Check with
`git check-ignore -v .env.local`; it must print a matching rule.

- [ ] **Step 6: Write the failing test**

Create `src/lib/wars/__tests__/palette.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { CANVAS_GROUND, PALETTE, PALETTE_SIZE, colourForSlot, rgba, rgbDistance } from "../palette";

// Slot 0 must be unmistakably "nobody has been here". A viewer should never
// have to wonder whether a region is empty or somebody's territory.
const MIN_GROUND_DISTANCE = 64;

describe("palette", () => {
  it("has exactly 24 token colours", () => {
    expect(PALETTE).toHaveLength(24);
    expect(PALETTE_SIZE).toBe(24);
  });

  it("has no duplicate token colours", () => {
    expect(new Set(PALETTE.map((c) => c.toLowerCase())).size).toBe(24);
  });

  it("uses well-formed hex everywhere", () => {
    for (const colour of [...PALETTE, CANVAS_GROUND]) {
      expect(colour).toMatch(/^#[0-9A-F]{6}$/);
    }
  });

  it("never assigns the canvas ground to a token", () => {
    expect(PALETTE.map((c) => c.toLowerCase())).not.toContain(CANVAS_GROUND.toLowerCase());
  });

  it("keeps the ground away from pure black and pure white", () => {
    // Both are real token colours, and an all-white board reads as a broken
    // render while an all-black one reads as nothing loaded.
    expect(CANVAS_GROUND).not.toBe("#000000");
    expect(CANVAS_GROUND).not.toBe("#FFFFFF");
  });

  it("keeps the ground far from every token colour", () => {
    for (const colour of PALETTE) {
      expect(rgbDistance(CANVAS_GROUND, colour)).toBeGreaterThanOrEqual(MIN_GROUND_DISTANCE);
    }
  });

  it("maps slot 0 to the ground and slots 1-24 to token colours", () => {
    expect(colourForSlot(0)).toBe(CANVAS_GROUND);
    expect(colourForSlot(1)).toBe(PALETTE[0]);
    expect(colourForSlot(24)).toBe(PALETTE[23]);
    expect(() => colourForSlot(25)).toThrow();
    expect(() => colourForSlot(-1)).toThrow();
  });

  it("exposes a slot-indexed RGBA table for the renderer", () => {
    const table = rgba();
    expect(table).toHaveLength(25 * 4);
    expect([table[0], table[1], table[2], table[3]]).toEqual([0x2e, 0x2e, 0x38, 255]);
    expect([table[4], table[5], table[6], table[7]]).toEqual([0xbe, 0x00, 0x39, 255]);
  });
});
```

- [ ] **Step 7: Run it and watch it fail**

Run: `npx vitest run src/lib/wars/__tests__/palette.test.ts`
Expected: FAIL — cannot resolve `../palette`.

- [ ] **Step 8: Write the implementation**

Create `src/lib/wars/palette.ts`:

```ts
/**
 * Twenty-four token colours and the ground they sit on.
 *
 * The palette IS the attribution model. A canvas byte is a palette slot, a
 * palette slot is a token, so the board needs no second data structure to say
 * who owns what. Slot 0 means unpainted and belongs to no token.
 *
 * These are the r/place 2022 values, which the whole lineage of clones settled
 * on because they stay distinguishable at one-pixel size. Saying so plainly is
 * better than pretending otherwise. The visual design pass owns this list and
 * may replace it; the tests are the contract it has to keep.
 */

export const PALETTE = [
  "#BE0039", "#FF4500", "#FFA800", "#FFD635", "#FFF8B8", "#00A368",
  "#00CC78", "#7EED56", "#00756F", "#009EAA", "#00CCC0", "#2450A4",
  "#3690EA", "#51E9F4", "#493AC1", "#6A5CFF", "#811E9F", "#B44AC0",
  "#FF3881", "#FF99AA", "#6D482F", "#FFB470", "#000000", "#FFFFFF",
] as const;

export const PALETTE_SIZE = PALETTE.length;

/**
 * Slot 0: unpainted.
 *
 * A desaturated slate, and deliberately not a colour any token can hold — no
 * entry in PALETTE is grey — so empty space can only ever read as empty space.
 */
export const CANVAS_GROUND = "#2E2E38";

export function colourForSlot(slot: number): string {
  if (!Number.isInteger(slot) || slot < 0 || slot > PALETTE_SIZE) {
    throw new RangeError(`Colour slot ${slot} is outside 0..${PALETTE_SIZE}`);
  }
  return slot === 0 ? CANVAS_GROUND : PALETTE[slot - 1];
}

export function toRgb(hex: string): [number, number, number] {
  const value = Number.parseInt(hex.slice(1), 16);
  return [(value >> 16) & 255, (value >> 8) & 255, value & 255];
}

/** Straight-line distance in RGB. Crude, and enough to catch a collision. */
export function rgbDistance(a: string, b: string): number {
  const [ar, ag, ab] = toRgb(a);
  const [br, bg, bb] = toRgb(b);
  return Math.hypot(ar - br, ag - bg, ab - bb);
}

/** Slot-indexed RGBA, for painting an ImageData buffer without a lookup map. */
export function rgba(): Uint8ClampedArray {
  const table = new Uint8ClampedArray((PALETTE_SIZE + 1) * 4);
  for (let slot = 0; slot <= PALETTE_SIZE; slot++) {
    const [r, g, b] = toRgb(colourForSlot(slot));
    table.set([r, g, b, 255], slot * 4);
  }
  return table;
}
```

- [ ] **Step 9: Run the tests and watch them pass**

Run: `npm test`
Expected: 8 passed.

- [ ] **Step 10: Confirm the app still builds**

Run: `npm run lint && npm run build`
Expected: both clean.

- [ ] **Step 11: Commit**

```bash
git add -A
git commit -m "Scaffold the app and pin the palette

Slot 0 is unpainted and is not a colour any token can hold. The tests hold the
line a future design pass has to keep: 24 distinct colours, none of them the
ground, and the ground far enough from all of them to be unmistakable."
```

---

### Task 2: Viewport maths and the pixel buffer


**Files:**
- Create: `src/lib/canvas/viewport.ts`, `src/lib/canvas/board-image.ts`
- Test: `src/lib/canvas/__tests__/viewport.test.ts`, `src/lib/canvas/__tests__/board-image.test.ts`

**Interfaces:**
- Consumes: `rgba` from `wars/palette.ts` (Task 1).
- Produces:
  - type `Viewport = { centreX: number; centreY: number; scale: number }`
  - `boardToScreen(v: Viewport, screen: Size, board: { x: number; y: number }): { x: number; y: number }`
  - `screenToBoard(v: Viewport, screen: Size, point: { x: number; y: number }): { x: number; y: number }`
  - `pixelAt(v: Viewport, screen: Size, point, size: Size): { x: number; y: number } | null`
  - `zoomAt(v: Viewport, screen: Size, point, factor: number, limits: { min: number; max: number }): Viewport`
  - `panBy(v: Viewport, dx: number, dy: number): Viewport`
  - `clampToBoard(v: Viewport, board: Size): Viewport`
  - `isTap(totalMovement: number): boolean`, `TAP_SLOP_PX = 8`
  - class `BoardImage` with `constructor(width, height)`, `setBase(bytes)`, `applyChange(idx, slot)`, `slotAt(idx)`, `rgbaBuffer: Uint8ClampedArray`

- [ ] **Step 1: Write the failing viewport test**

Create `src/lib/canvas/__tests__/viewport.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import {
  TAP_SLOP_PX,
  clampToBoard,
  isTap,
  panBy,
  pixelAt,
  screenToBoard,
  zoomAt,
} from "../viewport";

const SCREEN = { width: 800, height: 600 };
const BOARD = { width: 200, height: 200 };
const CENTRED = { centreX: 100, centreY: 100, scale: 2 };

describe("viewport", () => {
  it("puts the viewport centre at the middle of the screen", () => {
    expect(screenToBoard(CENTRED, SCREEN, { x: 400, y: 300 })).toEqual({ x: 100, y: 100 });
  });

  it("converts screen to board at the current scale", () => {
    // 40 screen pixels right of centre, at 2x, is 20 board pixels.
    expect(screenToBoard(CENTRED, SCREEN, { x: 440, y: 300 })).toEqual({ x: 120, y: 100 });
  });

  it("keeps the board point under the cursor fixed while zooming", () => {
    // This is the whole contract of zoom-to-cursor: whatever you point at is
    // still under the pointer afterwards.
    const point = { x: 600, y: 200 };
    const before = screenToBoard(CENTRED, SCREEN, point);
    const zoomed = zoomAt(CENTRED, SCREEN, point, 2, { min: 1, max: 64 });
    const after = screenToBoard(zoomed, SCREEN, point);

    expect(after.x).toBeCloseTo(before.x, 6);
    expect(after.y).toBeCloseTo(before.y, 6);
    expect(zoomed.scale).toBe(4);
  });

  it("refuses to zoom past its limits", () => {
    expect(zoomAt(CENTRED, SCREEN, { x: 400, y: 300 }, 100, { min: 1, max: 8 }).scale).toBe(8);
    expect(zoomAt(CENTRED, SCREEN, { x: 400, y: 300 }, 0.001, { min: 1, max: 8 }).scale).toBe(1);
  });

  it("pans in board units, so a drag moves the same board distance at any zoom", () => {
    expect(panBy({ ...CENTRED, scale: 2 }, 10, 0).centreX).toBe(110);
  });

  it("keeps the viewport centre on the board", () => {
    expect(clampToBoard({ centreX: -50, centreY: 900, scale: 4 }, BOARD)).toEqual({
      centreX: 0,
      centreY: 200,
      scale: 4,
    });
  });

  it("floors a screen point to the pixel it lands in", () => {
    expect(pixelAt(CENTRED, SCREEN, { x: 401, y: 301 }, BOARD)).toEqual({ x: 100, y: 100 });
  });

  it("returns nothing for a point outside the board", () => {
    const farOut = { centreX: 0, centreY: 0, scale: 1 };
    expect(pixelAt(farOut, SCREEN, { x: 0, y: 0 }, BOARD)).toBeNull();
  });

  it("treats a small movement as a tap and a large one as a drag", () => {
    // Without this, every pan on a phone ends in an accidental pixel.
    expect(isTap(0)).toBe(true);
    expect(isTap(TAP_SLOP_PX - 1)).toBe(true);
    expect(isTap(TAP_SLOP_PX + 1)).toBe(false);
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npx vitest run src/lib/canvas/__tests__/viewport.test.ts`
Expected: FAIL — cannot resolve `../viewport`.

- [ ] **Step 3: Write `viewport.ts`**

```ts
/**
 * Zoom, pan, and the screen-to-board conversion, with no DOM in sight.
 *
 * Kept pure so the fiddly part — the part where a zoom drifts by half a pixel
 * and nobody can say why — is unit tested instead of eyeballed.
 */

export type Size = { width: number; height: number };
export type Point = { x: number; y: number };
export type Viewport = { centreX: number; centreY: number; scale: number };

/**
 * How far a pointer may travel and still count as a tap.
 *
 * Every pan on a touchscreen ends with a pointerup somewhere on the canvas. If
 * that always painted, the board would fill with pixels nobody meant to place.
 */
export const TAP_SLOP_PX = 8;

export function isTap(totalMovement: number): boolean {
  return totalMovement <= TAP_SLOP_PX;
}

export function boardToScreen(v: Viewport, screen: Size, board: Point): Point {
  return {
    x: screen.width / 2 + (board.x - v.centreX) * v.scale,
    y: screen.height / 2 + (board.y - v.centreY) * v.scale,
  };
}

export function screenToBoard(v: Viewport, screen: Size, point: Point): Point {
  return {
    x: v.centreX + (point.x - screen.width / 2) / v.scale,
    y: v.centreY + (point.y - screen.height / 2) / v.scale,
  };
}

/** The pixel a screen point lands in, or null when it lands off the board. */
export function pixelAt(v: Viewport, screen: Size, point: Point, board: Size): Point | null {
  const { x, y } = screenToBoard(v, screen, point);
  const px = Math.floor(x);
  const py = Math.floor(y);
  if (px < 0 || py < 0 || px >= board.width || py >= board.height) return null;
  return { x: px, y: py };
}

/** Zooms about a screen point, leaving whatever is under it exactly where it is. */
export function zoomAt(
  v: Viewport,
  screen: Size,
  point: Point,
  factor: number,
  limits: { min: number; max: number },
): Viewport {
  const scale = Math.min(limits.max, Math.max(limits.min, v.scale * factor));
  if (scale === v.scale) return v;

  const anchor = screenToBoard(v, screen, point);
  const offsetX = point.x - screen.width / 2;
  const offsetY = point.y - screen.height / 2;

  return {
    scale,
    centreX: anchor.x - offsetX / scale,
    centreY: anchor.y - offsetY / scale,
  };
}

export function panBy(v: Viewport, dxBoard: number, dyBoard: number): Viewport {
  return { ...v, centreX: v.centreX + dxBoard, centreY: v.centreY + dyBoard };
}

/** Keeps the centre on the board, so the canvas cannot be lost off-screen. */
export function clampToBoard(v: Viewport, board: Size): Viewport {
  return {
    ...v,
    centreX: Math.min(board.width, Math.max(0, v.centreX)),
    centreY: Math.min(board.height, Math.max(0, v.centreY)),
  };
}
```

- [ ] **Step 4: Run the tests and watch them pass**

Run: `npx vitest run src/lib/canvas/__tests__/viewport.test.ts`
Expected: 9 passed.

- [ ] **Step 5: Write the failing board-image test**

Create `src/lib/canvas/__tests__/board-image.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { BoardImage } from "../board-image";
import { toRgb } from "../../wars/palette";

describe("BoardImage", () => {
  it("starts every pixel on the canvas ground", () => {
    const image = new BoardImage(4, 4);
    const [r, g, b] = toRgb("#2E2E38");
    expect([...image.rgbaBuffer.slice(0, 4)]).toEqual([r, g, b, 255]);
    expect(image.slotAt(0)).toBe(0);
  });

  it("paints the whole base in one go", () => {
    const image = new BoardImage(2, 2);
    image.setBase(new Uint8Array([1, 0, 13, 24]));

    expect(image.slotAt(0)).toBe(1);
    expect(image.slotAt(2)).toBe(13);
    const [r, g, b] = toRgb("#BE0039");
    expect([...image.rgbaBuffer.slice(0, 4)]).toEqual([r, g, b, 255]);
  });

  it("applies a single change without touching its neighbours", () => {
    const image = new BoardImage(2, 2);
    image.setBase(new Uint8Array([1, 1, 1, 1]));
    image.applyChange(2, 24);

    expect(image.slotAt(2)).toBe(24);
    expect(image.slotAt(1)).toBe(1);
    expect([...image.rgbaBuffer.slice(8, 12)]).toEqual([255, 255, 255, 255]);
  });

  it("returns a pixel to the ground when a change clears it", () => {
    const image = new BoardImage(2, 2);
    image.setBase(new Uint8Array([5, 5, 5, 5]));
    image.applyChange(0, 0);

    expect(image.slotAt(0)).toBe(0);
    const [r, g, b] = toRgb("#2E2E38");
    expect([...image.rgbaBuffer.slice(0, 4)]).toEqual([r, g, b, 255]);
  });

  it("ignores a change outside the board rather than corrupting the buffer", () => {
    const image = new BoardImage(2, 2);
    expect(() => image.applyChange(99, 3)).not.toThrow();
    expect(image.rgbaBuffer).toHaveLength(16);
  });

  it("ignores a slot outside the palette, keeping slots and pixels in step", () => {
    // Writing the slot but failing the palette lookup would leave the pixel
    // showing its old colour while slotAt() claims otherwise: a canvas that
    // lies rather than one with a hole in it.
    const image = new BoardImage(2, 2);
    image.setBase(new Uint8Array([7, 7, 7, 7]));
    image.applyChange(0, 255);

    expect(image.slotAt(0)).toBe(7);
    expect([...image.rgbaBuffer.slice(0, 4)]).toEqual([...image.rgbaBuffer.slice(4, 8)]);
  });

  it("turns an unrenderable byte in the base into unpainted, not a stale colour", () => {
    const image = new BoardImage(2, 2);
    image.setBase(new Uint8Array([1, 200, 1, 1]));

    expect(image.slotAt(1)).toBe(0);
    const [r, g, b] = toRgb("#2E2E38");
    expect([...image.rgbaBuffer.slice(4, 8)]).toEqual([r, g, b, 255]);
  });

  it("rejects a base of the wrong size, which would silently shear the board", () => {
    const image = new BoardImage(2, 2);
    expect(() => image.setBase(new Uint8Array(3))).toThrow(/expected 4 bytes/);
  });
});
```

- [ ] **Step 6: Run it and watch it fail**

Run: `npx vitest run src/lib/canvas/__tests__/board-image.test.ts`
Expected: FAIL — cannot resolve `../board-image`.

- [ ] **Step 7: Write `board-image.ts`**

```ts
import { PALETTE_SIZE, rgba } from "../wars/palette";

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
    // Anything outside the palette becomes unpainted, in BOTH buffers. A
    // corrupt board should degrade to holes, never to stale colours.
    for (let idx = 0; idx < bytes.length; idx++) {
      this.slots[idx] = this.isKnownSlot(bytes[idx]) ? bytes[idx] : 0;
    }
    this.repaintAll();
  }

  applyChange(idx: number, slot: number): void {
    if (idx < 0 || idx >= this.slots.length) return;
    // An unknown slot is data we cannot render. Dropping the change keeps the
    // two buffers in step; writing it would leave the slot updated and the
    // pixel showing its previous colour, which is a wrong canvas rather than
    // an incomplete one. The next full fetch repairs the gap.
    if (!this.isKnownSlot(slot)) return;
    this.slots[idx] = slot;
    this.paintOne(idx);
  }

  slotAt(idx: number): number {
    return this.slots[idx] ?? 0;
  }

  private isKnownSlot(slot: number): boolean {
    return Number.isInteger(slot) && slot >= 0 && slot <= PALETTE_SIZE;
  }

  private repaintAll(): void {
    for (let idx = 0; idx < this.slots.length; idx++) this.paintOne(idx);
  }

  private paintOne(idx: number): void {
    const offset = this.slots[idx] * 4;
    this.rgbaBuffer.set(this.palette.subarray(offset, offset + 4), idx * 4);
  }
}
```

- [ ] **Step 8: Run the tests and watch them pass**

Run: `npx vitest run src/lib/canvas/__tests__/`
Expected: 21 passed.

- [ ] **Step 9: Commit**

```bash
git add src/lib/canvas/viewport.ts src/lib/canvas/board-image.ts src/lib/canvas/__tests__
git commit -m "Add viewport maths and the pixel buffer

Both are pure and unit tested. Zoom-to-cursor and the tap-versus-drag
threshold are exactly the things that drift by half a pixel and never get
noticed until somebody paints where they meant to pan."
```

---

---

### Task 3: Painter identity, client IP, and subnet


**Files:**
- Create: `src/lib/config.ts`, `src/lib/paint/painter.ts`, `src/lib/paint/client-ip.ts`
- Test: `src/lib/paint/__tests__/painter.test.ts`, `src/lib/paint/__tests__/client-ip.test.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces:
  - `rateLimitSalt(): string`, `painterCookieSecret(): string`, `trustedProxyHops(): number`, `allowUntrustedClientIp(): boolean` from `src/lib/config.ts`
  - `PAINTER_COOKIE: "pw_painter"`, `issuePainter(): { cookieValue: string; painterKey: string }`, `readPainter(request: Request): string | null` (returns the painter key), `painterKeyFor(id: string): string`, `painterSetCookie(value: string): string` from `src/lib/paint/painter.ts`
  - `clientIp(request: Request): { ok: true; ip: string; source: string } | { ok: false; reason: string }`, `hashIp(ip: string): string`, `subnetKey(ip: string): string` from `src/lib/paint/client-ip.ts`

- [ ] **Step 1: Copy the client-IP logic from bidoor**

```bash
mkdir -p src/lib/paint
sed -n '/^const PLATFORM_IP_HEADERS/,/^}/p' ~/proyectos/outbid-tokens/src/lib/payments/limits.ts
```

Read `clientIp` and `hashIp` in bidoor's `src/lib/payments/limits.ts` and carry
them across verbatim into `src/lib/paint/client-ip.ts`, keeping every comment.
The rule they encode — proxies *append* to `x-forwarded-for`, so the
trustworthy entry is counted from the right — is the difference between a rate
limit and a header anyone can forge to get their own bucket.

- [ ] **Step 2: Write the failing test for client IP and subnets**

Create `src/lib/paint/__tests__/client-ip.test.ts`:

```ts
import { beforeEach, describe, expect, it } from "vitest";
import { clientIp, hashIp, subnetKey } from "../client-ip";

function request(headers: Record<string, string>): Request {
  return new Request("https://pixelwar.fun/api/paint", { headers });
}

describe("clientIp", () => {
  beforeEach(() => {
    process.env.TRUSTED_PROXY_HOPS = "1";
    delete process.env.ALLOW_UNTRUSTED_CLIENT_IP;
  });

  it("prefers a platform header a caller cannot forge", () => {
    const identity = clientIp(request({ "cf-connecting-ip": "1.2.3.4", "x-forwarded-for": "9.9.9.9" }));
    expect(identity).toEqual({ ok: true, ip: "1.2.3.4", source: "cf-connecting-ip" });
  });

  it("reads x-forwarded-for from the right, not the left", () => {
    // The caller wrote 9.9.9.9; our proxy appended 1.2.3.4. Reading the left
    // entry would let anyone choose their own rate-limit bucket.
    const identity = clientIp(request({ "x-forwarded-for": "9.9.9.9, 1.2.3.4" }));
    expect(identity).toMatchObject({ ok: true, ip: "1.2.3.4" });
  });

  it("fails closed when no header can be trusted", () => {
    expect(clientIp(request({})).ok).toBe(false);
  });

  it("allows an untrusted address only when development says so", () => {
    process.env.ALLOW_UNTRUSTED_CLIENT_IP = "true";
    expect(clientIp(request({})).ok).toBe(true);
  });
});

describe("hashIp", () => {
  beforeEach(() => {
    process.env.RATE_LIMIT_SALT = "test-salt";
  });

  it("is stable for one address and different across addresses", () => {
    expect(hashIp("1.2.3.4")).toBe(hashIp("1.2.3.4"));
    expect(hashIp("1.2.3.4")).not.toBe(hashIp("1.2.3.5"));
  });

  it("never returns the address itself", () => {
    expect(hashIp("1.2.3.4")).not.toContain("1.2.3.4");
  });

  it("changes completely when the salt changes", () => {
    const before = hashIp("1.2.3.4");
    process.env.RATE_LIMIT_SALT = "another-salt";
    expect(hashIp("1.2.3.4")).not.toBe(before);
  });
});

describe("subnetKey", () => {
  beforeEach(() => {
    process.env.RATE_LIMIT_SALT = "test-salt";
  });

  it("groups an IPv4 /24 together", () => {
    expect(subnetKey("1.2.3.4")).toBe(subnetKey("1.2.3.200"));
    expect(subnetKey("1.2.3.4")).not.toBe(subnetKey("1.2.4.4"));
  });

  it("groups an IPv6 /64 together", () => {
    expect(subnetKey("2001:db8:1:2:3:4:5:6")).toBe(subnetKey("2001:db8:1:2:ffff:ffff:ffff:ffff"));
    expect(subnetKey("2001:db8:1:2::1")).not.toBe(subnetKey("2001:db8:1:3::1"));
  });

  it("treats a compressed IPv6 address as the same prefix as its expanded form", () => {
    expect(subnetKey("2001:db8::1")).toBe(subnetKey("2001:0db8:0000:0000::9"));
  });

  it("is hashed, so it never carries a raw prefix", () => {
    expect(subnetKey("1.2.3.4")).not.toContain("1.2.3");
  });

  it("keeps two different IPv4-mapped addresses in different buckets", () => {
    // A dual-stack listener reports IPv4 clients in this form. Splitting on
    // ":" leaves the octets in the last group, where the /64 prefix never
    // sees them — so every address of this shape hashed to one key and
    // unrelated strangers shared a burst cap.
    expect(subnetKey("::ffff:1.2.3.4")).not.toBe(subnetKey("::ffff:9.9.9.9"));
    expect(subnetKey("::ffff:1.2.3.4")).not.toBe(subnetKey("::1"));
  });

  it("treats an IPv4-mapped address as the IPv4 client it is", () => {
    expect(subnetKey("::ffff:1.2.3.4")).toBe(subnetKey("1.2.3.4"));
    expect(hashIp("::ffff:1.2.3.4")).toBe(hashIp("1.2.3.4"));
  });
});
```

- [ ] **Step 3: Run it and watch it fail**

Run: `npx vitest run src/lib/paint/__tests__/client-ip.test.ts`
Expected: FAIL — `subnetKey` is not exported.

- [ ] **Step 4: Write config and finish `client-ip.ts`**

Create `src/lib/config.ts`:

```ts
/**
 * Environment readers.
 *
 * Each one throws rather than defaulting. A default for any of these is a
 * production deploy that looks healthy while doing the wrong thing: an unsalted
 * hash, an unsigned cookie, or a rate limit anyone can opt out of.
 */

function required(name: string, why: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is not set. ${why}`);
  return value;
}

export function rateLimitSalt(): string {
  return required(
    "RATE_LIMIT_SALT",
    "An unsalted SHA-256 of an IPv4 address is reversible by brute force, so the " +
      "stored hashes would be visitor IP addresses in all but name.",
  );
}

export function painterCookieSecret(): string {
  return required(
    "PAINTER_COOKIE_SECRET",
    "Without it anyone can mint a painter identity per pixel and the cooldown means nothing.",
  );
}

export function trustedProxyHops(): number {
  const raw = process.env.TRUSTED_PROXY_HOPS?.trim();
  const parsed = raw ? Number.parseInt(raw, 10) : 1;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 1;
}

export function allowUntrustedClientIp(): boolean {
  return process.env.ALLOW_UNTRUSTED_CLIENT_IP?.trim() === "true";
}

/**
 * Paints allowed per subnet per window, before the burst cap bites.
 *
 * A function, not a constant: a module-level constant freezes the value at
 * import time, which makes it unreadable to any test that needs a different
 * cap and untunable without a redeploy.
 */
export function subnetBurst(): { cap: number; windowSeconds: number } {
  return {
    cap: Number.parseInt(process.env.PAINT_SUBNET_BURST ?? "60", 10),
    windowSeconds: Number.parseInt(process.env.PAINT_SUBNET_WINDOW_SECONDS ?? "60", 10),
  };
}

/** Beyond this many changes, a client is told to refetch the board instead. */
export function diffMaxChanges(): number {
  return Number.parseInt(process.env.DIFF_MAX_CHANGES ?? "8000", 10);
}
```

Append `subnetKey` to `src/lib/paint/client-ip.ts`:

```ts
import { createHash } from "node:crypto";
import { rateLimitSalt } from "../config";

// ... clientIp and hashIp, carried over from bidoor ...

/**
 * The address's network prefix, hashed.
 *
 * A phone cycling through a carrier's pool gets a fresh address on every
 * reconnect but not a fresh prefix, so the prefix is where rotation actually
 * shows up. /24 for IPv4 and /64 for IPv6 are the smallest blocks routinely
 * allocated to one subscriber; going narrower would start grouping strangers
 * together, which turns a burst cap into an outage for a neighbourhood.
 */
export function subnetKey(ip: string): string {
  return createHash("sha256")
    .update(`${rateLimitSalt()}:subnet:${prefixOf(normaliseIp(ip))}`)
    .digest("hex");
}

/**
 * One canonical spelling per client, before anything is hashed.
 *
 * A dual-stack listener reports an IPv4 client as `::ffff:1.2.3.4`, and the
 * same client can arrive in either spelling depending on which header carried
 * it. Hashing both forms gives one visitor two cooldown buckets, which is the
 * cooldown quietly halving itself. Both `hashIp` and `subnetKey` go through
 * here so the two keys cannot disagree about who somebody is.
 */
export function normaliseIp(ip: string): string {
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(ip.trim());
  return mapped ? mapped[1] : ip.trim().toLowerCase();
}

function prefixOf(ip: string): string {
  if (ip.includes(":")) return `${expandIpv6(ip).slice(0, 4).join(":")}::/64`;

  const octets = ip.split(".");
  if (octets.length !== 4) return ip; // not an address we recognise; group it alone
  return `${octets.slice(0, 3).join(".")}.0/24`;
}

/**
 * A known limit, recorded rather than fixed: clients behind one NAT64 gateway
 * share a bucket.
 *
 * An IPv6 address with an embedded IPv4 tail — `64:ff9b::1.2.3.4` — carries
 * that IPv4 in its last 32 bits, which are inside the /64. So every client
 * behind one NAT64 prefix groups together no matter how the address is
 * expanded, and no rewriting of the tail can change that.
 *
 * This is left alone deliberately, because it is the same trade the IPv4 side
 * already makes: a /24 lumps a CGNAT pool together too. `::ffff:a.b.c.d` is
 * the case that IS handled, in `normaliseIp` — not by adjusting the prefix,
 * but by recognising that such an address is simply an IPv4 client wearing an
 * IPv6 spelling, and sending it down the /24 path.
 */

/** Eight lowercase, unpadded groups. "2001:db8::1" and "2001:0db8:0:0::1" agree. */
function expandIpv6(ip: string): string[] {
  const [head, tail = ""] = ip.toLowerCase().split("::");
  const left = head ? head.split(":") : [];
  const right = tail ? tail.split(":") : [];
  const missing = 8 - left.length - right.length;
  const middle = ip.includes("::") ? Array(Math.max(0, missing)).fill("0") : [];
  return [...left, ...middle, ...right].map((group) =>
    String(Number.parseInt(group || "0", 16).toString(16)),
  );
}
```

- [ ] **Step 5: Run the tests and watch them pass**

Run: `npx vitest run src/lib/paint/__tests__/client-ip.test.ts`
Expected: 11 passed.

- [ ] **Step 6: Write the failing test for painter identity**

Create `src/lib/paint/__tests__/painter.test.ts`:

```ts
import { beforeEach, describe, expect, it } from "vitest";
import { PAINTER_COOKIE, issuePainter, painterSetCookie, readPainter } from "../painter";

function withCookie(value: string): Request {
  return new Request("https://pixelwar.fun/api/paint", {
    headers: { cookie: `${PAINTER_COOKIE}=${value}` },
  });
}

describe("painter identity", () => {
  beforeEach(() => {
    process.env.PAINTER_COOKIE_SECRET = "secret-under-test";
    process.env.RATE_LIMIT_SALT = "test-salt";
  });

  it("issues a different identity each time", () => {
    expect(issuePainter().cookieValue).not.toBe(issuePainter().cookieValue);
  });

  it("reads back the key it issued", () => {
    const issued = issuePainter();
    expect(readPainter(withCookie(issued.cookieValue))).toBe(issued.painterKey);
  });

  it("rejects a cookie whose signature does not match", () => {
    const issued = issuePainter();
    const [id] = issued.cookieValue.split(".");
    expect(readPainter(withCookie(`${id}.forged-signature`))).toBeNull();
  });

  it("rejects a cookie signed with a different secret", () => {
    const issued = issuePainter();
    process.env.PAINTER_COOKIE_SECRET = "a-different-secret";
    expect(readPainter(withCookie(issued.cookieValue))).toBeNull();
  });

  it("rejects malformed cookies rather than trusting them", () => {
    // "%" is a malformed percent-escape: decodeURIComponent throws on it, and
    // a junk cookie must be a rejection, not a 500 on the paint route.
    for (const value of ["", "no-dot", ".", "a.b.c", "%", "%zz", "abc%"]) {
      expect(readPainter(withCookie(value))).toBeNull();
    }
  });

  it("returns null when there is no cookie at all", () => {
    expect(readPainter(new Request("https://pixelwar.fun/api/paint"))).toBeNull();
  });

  it("never stores anything that could reconstruct the cookie", () => {
    const issued = issuePainter();
    const [id] = issued.cookieValue.split(".");
    // The key is a salted hash of the id. Holding the key must not be enough
    // to mint a valid cookie, so a database leak is not a forgery kit.
    expect(issued.painterKey).not.toContain(id);
    expect(issued.cookieValue).not.toContain(issued.painterKey);
  });

  it("sets a cookie that a script cannot read and a cross-site request cannot send", () => {
    const header = painterSetCookie("value-under-test");
    expect(header).toContain("HttpOnly");
    expect(header).toContain("SameSite=Lax");
    expect(header).toContain("Secure");
    expect(header).toContain("Path=/");
  });
});
```

- [ ] **Step 7: Run it and watch it fail**

Run: `npx vitest run src/lib/paint/__tests__/painter.test.ts`
Expected: FAIL — cannot resolve `../painter`.

- [ ] **Step 8: Write the implementation**

Create `src/lib/paint/painter.ts`:

```ts
import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { painterCookieSecret, rateLimitSalt } from "../config";

/**
 * Who is painting, in the absence of accounts.
 *
 * A random id in a signed cookie. The signature is what makes it worth
 * anything: without it a caller mints a fresh identity per pixel and the
 * cooldown is decoration.
 *
 * The server stores only a salted hash of the id, never the id. Holding the
 * whole table is therefore not enough to forge a cookie, which is the
 * difference between a database leak and a database leak that hands somebody
 * unlimited paint.
 *
 * This is not a strong identity and is not meant to be one. It is one of two
 * keys — the other is the caller's address — and a paint has to satisfy both.
 */

export const PAINTER_COOKIE = "pw_painter";

/** Long enough that a returning visitor keeps their cooldown across a war. */
const COOKIE_MAX_AGE_SECONDS = 400 * 24 * 60 * 60;

function sign(id: string): string {
  return createHmac("sha256", painterCookieSecret()).update(id).digest("base64url");
}

export function painterKeyFor(id: string): string {
  return createHash("sha256").update(`${rateLimitSalt()}:painter:${id}`).digest("hex");
}

export function issuePainter(): { cookieValue: string; painterKey: string } {
  const id = randomBytes(16).toString("base64url");
  return { cookieValue: `${id}.${sign(id)}`, painterKey: painterKeyFor(id) };
}

/** The painter key carried by this request, or null if there is not a valid one. */
export function readPainter(request: Request): string | null {
  const raw = request.headers
    .get("cookie")
    ?.split(";")
    .map((part) => part.trim())
    .find((part) => part.startsWith(`${PAINTER_COOKIE}=`))
    ?.slice(PAINTER_COOKIE.length + 1);

  if (!raw) return null;

  // decodeURIComponent throws on a malformed escape — a cookie of "%" is
  // enough. This runs on every paint request, so it returns null like every
  // other rejection rather than turning a junk cookie into a 500.
  let decoded: string;
  try {
    decoded = decodeURIComponent(raw);
  } catch {
    return null;
  }

  const parts = decoded.split(".");
  if (parts.length !== 2) return null;

  const [id, signature] = parts;
  if (!id || !signature) return null;

  const expected = Buffer.from(sign(id));
  const offered = Buffer.from(signature);
  // Compare fixed-length digests: an early return on length would leak how
  // long the signature is.
  if (offered.length !== expected.length) return null;
  if (!timingSafeEqual(offered, expected)) return null;

  return painterKeyFor(id);
}

export function painterSetCookie(value: string): string {
  return [
    `${PAINTER_COOKIE}=${encodeURIComponent(value)}`,
    "Path=/",
    "HttpOnly",
    "Secure",
    "SameSite=Lax",
    `Max-Age=${COOKIE_MAX_AGE_SECONDS}`,
  ].join("; ");
}
```

- [ ] **Step 9: Run the tests and watch them pass**

Run: `npx vitest run src/lib/paint/__tests__/`
Expected: 19 passed.

- [ ] **Step 10: Commit**

```bash
git add src/lib/config.ts src/lib/paint src/lib/paint/__tests__
git commit -m "Add painter identity, client address, and subnet grouping

The painter cookie is signed and the server keeps only a salted hash of the id,
so holding the table is not enough to mint one. The subnet key exists because a
phone on mobile data gets a new address on every reconnect but keeps its prefix."
```

---

---

### Task 4: Neon and the database harness

**Files:**
- Create: `src/lib/db.ts`, `scripts/migrate.mts`, `migrations/000_bootstrap.sql`, `.env.example`
- Modify: `vitest.setup.ts`, `package.json`
- Test: `src/lib/__tests__/db.test.ts`

**Interfaces:**
- Consumes: the scaffold from Task 1.
- Produces: `pool()`, `query<T>(text, params): Promise<T[]>`, `queryOne<T>`, `execute(text, params): Promise<number>`, `transaction<T>(fn: (client: PoolClient) => Promise<T>): Promise<T>`, `isUniqueViolation(err): boolean`, `violatedConstraint(err): string`, `closePool(): Promise<void>` from `src/lib/db.ts`; the exported test helper `truncateAll()` from `vitest.setup.ts`; and the scripts `db:migrate`, `db:migrate:test`, `db:up`.

**There is no local Postgres.** The database is Neon, exactly as in bidoor.
Two branches of one Neon project: `production` holds the app database and
`tests` holds a disposable copy. Both connection strings live in `.env.local` and
nowhere else — never in `.env.example`, never in a commit, never in a comment.

- [ ] **Step 1: Install the driver**

```bash
npm install pg
npm install -D @types/pg
```

- [ ] **Step 2: Copy `db.ts` from bidoor**

```bash
cp ~/proyectos/outbid-tokens/src/lib/db.ts src/lib/db.ts
```

Read it before moving on. Change nothing structural: the pool cached on
`globalThis`, the deliberately swallowed pool error, and `isUniqueViolation`
are all load-bearing here too. Reword only the doc comment's references to
bidoor's board so it describes pixelwar.

- [ ] **Step 3: Write the migration runner**

Create `scripts/migrate.mts`:

```ts
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { config } from "dotenv";
import { Pool } from "pg";

/**
 * Applies every unapplied migration, in filename order, each inside its own
 * transaction. A migration that throws leaves the database exactly as it was
 * and stops the run: applying half a schema and reporting success is the one
 * outcome a migration tool must never produce.
 */

config({ path: ".env.local" });

const useTest = process.argv.includes("--test");
const url = useTest ? process.env.TEST_DATABASE_URL : process.env.DATABASE_URL;

if (!url) {
  console.error(
    `${useTest ? "TEST_DATABASE_URL" : "DATABASE_URL"} is not set. There is no default: ` +
      "a fallback would mean migrating the wrong database rather than failing.",
  );
  process.exit(1);
}

const pool = new Pool({ connectionString: url });
const dir = join(process.cwd(), "migrations");

await pool.query(`
  CREATE TABLE IF NOT EXISTS schema_migrations (
    version    TEXT PRIMARY KEY,
    applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
  )
`);

const applied = new Set(
  (await pool.query<{ version: string }>("SELECT version FROM schema_migrations")).rows.map(
    (row) => row.version,
  ),
);

const files = (await readdir(dir)).filter((name) => name.endsWith(".sql")).sort();
let count = 0;

for (const file of files) {
  const version = file.replace(/\.sql$/, "");
  if (applied.has(version)) continue;

  const sql = await readFile(join(dir, file), "utf8");
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(sql);
    await client.query("INSERT INTO schema_migrations (version) VALUES ($1)", [version]);
    await client.query("COMMIT");
    console.log(`applied ${version}`);
    count++;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    console.error(`failed on ${version}:`, error);
    process.exit(1);
  } finally {
    client.release();
  }
}

console.log(count === 0 ? "nothing to apply" : `applied ${count} migration(s)`);
await pool.end();
```

- [ ] **Step 4: Add a bootstrap migration**

Create `migrations/000_bootstrap.sql`:

```sql
-- Nothing structural yet; 001 carries the schema. This file exists so the
-- runner has a migration to apply and the harness has something to assert on.
CREATE TABLE IF NOT EXISTS bootstrap_check (
  ok BOOLEAN NOT NULL DEFAULT TRUE
);
```

- [ ] **Step 5: Add the scripts**

In `package.json`:

```json
{
  "db:migrate": "tsx scripts/migrate.mts",
  "db:migrate:test": "tsx scripts/migrate.mts --test",
  "db:up": "npm run db:migrate && npm run db:migrate:test"
}
```

There is no `db:reset`: dropping a Neon branch is not something a script
should do behind an npm alias. Resetting means resetting the `tests` branch
from the Neon console, on purpose.

- [ ] **Step 6: Write `.env.example`**

Following bidoor's style, where every variable explains why it has no default.
The file carries names and reasons only — never a real connection string:

```bash
# Postgres for the app, in every environment. Neon, branch `production`.
#
# Required, no default: a fallback would mean running against the wrong
# database rather than failing. Keep sslmode=verify-full: `require` encrypts
# but authenticates nothing, so it stops eavesdropping and not impersonation.
DATABASE_URL=

# Postgres for the TEST SUITE and nothing else. Neon, branch `tests`.
#
# Deliberately a different variable, and deliberately a different branch. The
# suite truncates every table between tests, so this must point at a database
# that is disposable on purpose. The suite refuses to start if it is the same
# as DATABASE_URL.
TEST_DATABASE_URL=

# Salt for hashing caller IP addresses.
#
# REQUIRED in production. An unsalted SHA-256 of an IPv4 address is reversible
# by brute force — four billion preimages — so the stored hashes would be
# visitor IP addresses in all but name. Generate with: openssl rand -hex 32
RATE_LIMIT_SALT=

# Secret that signs the painter cookie.
#
# REQUIRED in production, no default. Without it anyone can mint a painter
# identity per pixel and the cooldown means nothing.
# Generate with: openssl rand -hex 32
PAINTER_COOKIE_SECRET=

# Allow requests with no trustworthy client address. Local development only —
# it must stay unset in production, where no client address means no rate
# limiting at all.
# ALLOW_UNTRUSTED_CLIENT_IP=true

# How many proxies sit in front of this app and append to x-forwarded-for.
# Default 1, which matches Vercel.
# TRUSTED_PROXY_HOPS=1
```

- [ ] **Step 7: Extend `vitest.setup.ts` with the database guards**

```ts
import { config } from "dotenv";
import { afterAll, beforeAll, beforeEach } from "vitest";
import { closePool, execute, query } from "./src/lib/db";

config({ path: ".env.local" });

beforeAll(() => {
  const test = process.env.TEST_DATABASE_URL?.trim();
  const app = process.env.DATABASE_URL?.trim();

  if (!test) {
    throw new Error(
      "TEST_DATABASE_URL is not set. The suite truncates every table, so it " +
        "refuses to run without a database that is explicitly disposable.",
    );
  }
  // Compare where the two URLs POINT, not how they are spelled. A trailing
  // slash, a different letter case in the host, or an extra query parameter
  // makes two strings unequal while they still address the same database —
  // and this guard is the only thing between a hand-edited .env.local and
  // TRUNCATE running against production.
  if (sameTarget(test, app)) {
    throw new Error(
      "TEST_DATABASE_URL and DATABASE_URL point at the same database. The suite " +
        "truncates every table; pointing it at the app database would delete real data.",
    );
  }

  // Everything under test reads DATABASE_URL. Redirect it once, here.
  process.env.DATABASE_URL = test;
});

/**
 * True when two connection strings address the same database.
 *
 * Host, port and database name only. Credentials and query parameters are
 * deliberately ignored: connecting as a different role, or with a different
 * sslmode, still truncates the same tables.
 *
 * An unparseable URL is treated as a match — refusing to run is the safe
 * answer when we cannot tell what we are pointed at.
 */
function sameTarget(a: string, b: string): boolean {
  try {
    const left = new URL(a);
    const right = new URL(b);
    const key = (url: URL) =>
      `${url.hostname.toLowerCase()}:${url.port || "5432"}${url.pathname.replace(/\/+$/, "")}`;
    return key(left) === key(right);
  } catch {
    return true;
  }
}

/** Empties every table except the migration ledger. */
export async function truncateAll(): Promise<void> {
  const tables = await query<{ tablename: string }>(
    `SELECT tablename FROM pg_tables
      WHERE schemaname = 'public' AND tablename <> 'schema_migrations'`,
  );
  if (tables.length === 0) return;
  await execute(`TRUNCATE ${tables.map((t) => `"${t.tablename}"`).join(", ")} CASCADE`);
}

beforeEach(truncateAll);
afterAll(closePool);
```

- [ ] **Step 8: Write the failing test**

Create `src/lib/__tests__/db.test.ts`:

```ts
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
```

- [ ] **Step 9: Run it and watch it fail**

Run: `npm test`
Expected: FAIL — the Neon branches have no tables yet.

- [ ] **Step 10: Apply the migrations**

Run: `npm run db:up`
Expected: `applied 000_bootstrap` twice, once per branch.

If the first command hangs for a few seconds, that is Neon waking a suspended
branch, not a problem.

- [ ] **Step 11: Run the tests and watch them pass**

Run: `npm test`
Expected: 12 passed (8 palette, 4 database).

- [ ] **Step 12: Commit**

```bash
git add -A
git commit -m "Connect to Neon and guard the test database

The suite refuses to run unless TEST_DATABASE_URL is set and differs from
DATABASE_URL, because it truncates every table between tests. Connection
strings live in .env.local and nowhere else."
```

---

### Task 5: Schema and war lifecycle


**Files:**
- Create: `migrations/001_initial.sql`, `src/lib/wars/lifecycle.ts`
- Test: `src/lib/wars/__tests__/lifecycle.test.ts`
- Delete: `migrations/000_bootstrap.sql` is kept — it is already applied everywhere and removing it would make the ledger lie.

**Interfaces:**
- Consumes: `query`, `queryOne`, `execute`, `transaction` from `src/lib/db.ts` (Task 4).
- Produces:
  - type `War = { id: string; slug: string; title: string; status: "draft"|"scheduled"|"live"|"ended"|"cancelled"; width: number; height: number; maxTokens: number; entryPriceUsd: number; cooldownSeconds: number; startsAt: Date; endsAt: Date; lastSeq: number; endedAt: Date | null }`
  - type `WarToken = { id: string; warId: string; chainId: string; contract: string; colourSlot: number; status: "reserved"|"active"|"removed"|"released"; name: string; ticker: string; logoUrl: string | null }`
  - `warBySlug(slug: string): Promise<War | null>`
  - `currentWar(): Promise<War | null>`
  - `advanceWar(war: War): Promise<War>`
  - `activeTokens(warId: string): Promise<WarToken[]>`

- [ ] **Step 1: Write the migration**

Create `migrations/001_initial.sql` with the Batch A tables, exactly as
specified in §3 of the design doc. Orders, payments, snapshots and reports are
NOT in this file — they arrive with the batches that use them.

```sql
CREATE TABLE wars (
  id               TEXT PRIMARY KEY,
  slug             TEXT        NOT NULL UNIQUE,
  title            TEXT        NOT NULL,
  status           TEXT        NOT NULL DEFAULT 'draft'
                     CHECK (status IN ('draft','scheduled','live','ended','cancelled')),
  width            INTEGER     NOT NULL DEFAULT 200,
  height           INTEGER     NOT NULL DEFAULT 200,
  max_tokens       SMALLINT    NOT NULL DEFAULT 24 CHECK (max_tokens BETWEEN 1 AND 24),
  -- No DEFAULT, deliberately. An entry price a deploy can forget to set is an
  -- entry price somebody charges by accident.
  entry_price_usd  INTEGER     NOT NULL CHECK (entry_price_usd > 0),
  cooldown_seconds INTEGER     NOT NULL CHECK (cooldown_seconds BETWEEN 1 AND 3600),
  starts_at        TIMESTAMPTZ NOT NULL,
  ends_at          TIMESTAMPTZ NOT NULL,
  -- Monotonic and gapless. Allocated inside the paint transaction, never by a
  -- sequence: BIGSERIAL hands out values before commit, so a client polling
  -- ?since= could step over a row that committed late and lose it for good.
  last_seq         BIGINT      NOT NULL DEFAULT 0,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  ended_at         TIMESTAMPTZ,
  CHECK (ends_at > starts_at)
);

CREATE INDEX wars_status ON wars (status, starts_at);

CREATE TABLE war_tokens (
  id                  TEXT PRIMARY KEY,
  war_id              TEXT        NOT NULL REFERENCES wars (id),
  chain_id            TEXT        NOT NULL,
  contract            TEXT        NOT NULL,
  contract_key        TEXT        NOT NULL,
  colour_slot         SMALLINT    NOT NULL CHECK (colour_slot BETWEEN 1 AND 24),
  status              TEXT        NOT NULL DEFAULT 'reserved'
                        CHECK (status IN ('reserved','active','removed','released')),
  name                TEXT        NOT NULL,
  ticker              TEXT        NOT NULL,
  logo_url            TEXT,
  links               JSONB       NOT NULL DEFAULT '{}'::jsonb,
  metadata_fetched_at TIMESTAMPTZ NOT NULL,
  reserved_at         TIMESTAMPTZ NOT NULL,
  joined_at           TIMESTAMPTZ,
  released_at         TIMESTAMPTZ,
  released_reason     TEXT
);

-- A colour frees only when a reservation expires unpaid ('released'), never
-- when an operator pulls a token that already painted ('removed'): reissuing a
-- colour that has pixels on the board would hand one community's territory to
-- another.
CREATE UNIQUE INDEX war_tokens_colour_live
  ON war_tokens (war_id, colour_slot) WHERE status <> 'released';

CREATE UNIQUE INDEX war_tokens_contract_live
  ON war_tokens (war_id, contract_key) WHERE status <> 'released';

CREATE INDEX war_tokens_war ON war_tokens (war_id, status);

CREATE TABLE pixels (
  war_id       TEXT        NOT NULL REFERENCES wars (id),
  idx          INTEGER     NOT NULL,
  war_token_id TEXT        NOT NULL REFERENCES war_tokens (id),
  seq          BIGINT      NOT NULL,
  painted_at   TIMESTAMPTZ NOT NULL,
  painter_key  TEXT,
  ip_hash      TEXT,
  PRIMARY KEY (war_id, idx)
);

CREATE TABLE pixel_events (
  war_id      TEXT        NOT NULL REFERENCES wars (id),
  seq         BIGINT      NOT NULL,
  idx         INTEGER     NOT NULL,
  colour_slot SMALLINT    NOT NULL,
  painted_at  TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (war_id, seq)
);

CREATE TABLE token_pixel_counts (
  war_id       TEXT    NOT NULL REFERENCES wars (id),
  war_token_id TEXT    NOT NULL REFERENCES war_tokens (id),
  owned        INTEGER NOT NULL DEFAULT 0,
  placed       INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (war_id, war_token_id)
);

CREATE TABLE paint_cooldowns (
  war_id          TEXT        NOT NULL REFERENCES wars (id),
  key_type        TEXT        NOT NULL CHECK (key_type IN ('painter','ip','subnet')),
  key             TEXT        NOT NULL,
  last_painted_at TIMESTAMPTZ NOT NULL,
  -- Only meaningful for 'subnet', which is gated on a count per window rather
  -- than on an interval.
  window_start    TIMESTAMPTZ NOT NULL,
  window_count    INTEGER     NOT NULL DEFAULT 0,
  PRIMARY KEY (war_id, key_type, key)
);

CREATE TABLE bans (
  id         TEXT PRIMARY KEY,
  key_type   TEXT        NOT NULL CHECK (key_type IN ('painter','ip','subnet')),
  key        TEXT        NOT NULL,
  reason     TEXT,
  actor      TEXT        NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ
);

CREATE UNIQUE INDEX bans_key ON bans (key_type, key);
```

- [ ] **Step 2: Apply it**

Run: `npm run db:up`
Expected: `applied 001_initial` on both databases.

- [ ] **Step 3: Write the failing test**

Create `src/lib/wars/__tests__/lifecycle.test.ts`:

```ts
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
    `INSERT INTO wars (id, slug, title, status, entry_price_usd, cooldown_seconds, starts_at, ends_at)
     VALUES ($1, $1, 'Test war', $2, 25, 30, $3, $4)`,
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
```

- [ ] **Step 4: Run it and watch it fail**

Run: `npx vitest run src/lib/wars/__tests__/lifecycle.test.ts`
Expected: FAIL — cannot resolve `../lifecycle`.

- [ ] **Step 5: Write the implementation**

Create `src/lib/wars/lifecycle.ts`:

```ts
import { execute, query, queryOne } from "../db";

/**
 * War state, and the two transitions that happen without an operator.
 *
 * Both transitions run on every read of a war as well as on the reconcile
 * cron. GitHub's scheduler is best-effort and can run late; a war that ended
 * eleven minutes ago must not still be accepting paint because nobody
 * triggered a job.
 */

export type WarStatus = "draft" | "scheduled" | "live" | "ended" | "cancelled";

export type War = {
  id: string;
  slug: string;
  title: string;
  status: WarStatus;
  width: number;
  height: number;
  maxTokens: number;
  entryPriceUsd: number;
  cooldownSeconds: number;
  startsAt: Date;
  endsAt: Date;
  lastSeq: number;
  endedAt: Date | null;
};

export type WarToken = {
  id: string;
  warId: string;
  chainId: string;
  contract: string;
  colourSlot: number;
  status: "reserved" | "active" | "removed" | "released";
  name: string;
  ticker: string;
  logoUrl: string | null;
};

type WarRow = {
  id: string;
  slug: string;
  title: string;
  status: WarStatus;
  width: number;
  height: number;
  max_tokens: number;
  entry_price_usd: number;
  cooldown_seconds: number;
  starts_at: Date;
  ends_at: Date;
  last_seq: string;
  ended_at: Date | null;
};

// pg returns BIGINT as a string, because a 64-bit integer does not fit a JS
// number safely. Sequence numbers here will not approach 2^53, so converting
// is safe — but it has to happen in exactly one place, or somewhere downstream
// compares "10" < "9" and serves a diff that silently skips pixels.
function toWar(row: WarRow): War {
  return {
    id: row.id,
    slug: row.slug,
    title: row.title,
    status: row.status,
    width: row.width,
    height: row.height,
    maxTokens: row.max_tokens,
    entryPriceUsd: row.entry_price_usd,
    cooldownSeconds: row.cooldown_seconds,
    startsAt: row.starts_at,
    endsAt: row.ends_at,
    lastSeq: Number(row.last_seq),
    endedAt: row.ended_at,
  };
}

const WAR_COLUMNS = `id, slug, title, status, width, height, max_tokens,
  entry_price_usd, cooldown_seconds, starts_at, ends_at, last_seq, ended_at`;

export async function warBySlug(slug: string): Promise<War | null> {
  const row = await queryOne<WarRow>(
    `SELECT ${WAR_COLUMNS} FROM wars WHERE slug = $1`,
    [slug],
  );
  return row ? toWar(row) : null;
}

export async function warById(id: string): Promise<War | null> {
  const row = await queryOne<WarRow>(`SELECT ${WAR_COLUMNS} FROM wars WHERE id = $1`, [id]);
  return row ? toWar(row) : null;
}

/**
 * Moves a war to the state its own clock says it should be in.
 *
 * Both updates are guarded on the status they expect, so two callers racing
 * produce one winner and one no-op rather than two half-closes. The loser
 * re-reads and sees the same answer.
 */
export async function advanceWar(war: War): Promise<War> {
  const now = Date.now();

  if (war.status === "scheduled" && war.startsAt.getTime() <= now) {
    await execute(`UPDATE wars SET status = 'live' WHERE id = $1 AND status = 'scheduled'`, [
      war.id,
    ]);
    return (await warById(war.id))!;
  }

  if (war.status === "live" && war.endsAt.getTime() <= now) {
    await execute(
      `UPDATE wars SET status = 'ended', ended_at = now() WHERE id = $1 AND status = 'live'`,
      [war.id],
    );
    return (await warById(war.id))!;
  }

  return war;
}

/**
 * The war the home page shows: the one that is running, or the one about to.
 *
 * Advancing happens here rather than in the caller so that no route can forget
 * to do it.
 */
export async function currentWar(): Promise<War | null> {
  const row = await queryOne<WarRow>(
    `SELECT ${WAR_COLUMNS} FROM wars
      WHERE status IN ('live', 'scheduled')
      ORDER BY starts_at ASC
      LIMIT 1`,
  );
  if (!row) return null;

  const advanced = await advanceWar(toWar(row));
  return advanced.status === "ended" ? null : advanced;
}

export async function activeTokens(warId: string): Promise<WarToken[]> {
  const rows = await query<{
    id: string;
    war_id: string;
    chain_id: string;
    contract: string;
    colour_slot: number;
    status: WarToken["status"];
    name: string;
    ticker: string;
    logo_url: string | null;
  }>(
    `SELECT id, war_id, chain_id, contract, colour_slot, status, name, ticker, logo_url
       FROM war_tokens
      WHERE war_id = $1 AND status = 'active'
      ORDER BY colour_slot ASC`,
    [warId],
  );

  return rows.map((row) => ({
    id: row.id,
    warId: row.war_id,
    chainId: row.chain_id,
    contract: row.contract,
    colourSlot: row.colour_slot,
    status: row.status,
    name: row.name,
    ticker: row.ticker,
    logoUrl: row.logo_url,
  }));
}
```

- [ ] **Step 6: Run the tests and watch them pass**

Run: `npx vitest run src/lib/wars/__tests__/lifecycle.test.ts`
Expected: 7 passed.

- [ ] **Step 7: Commit**

```bash
git add migrations/001_initial.sql src/lib/wars/lifecycle.ts src/lib/wars/__tests__/lifecycle.test.ts
git commit -m "Add the canvas schema and the war lifecycle

Wars advance on read as well as on the cron: a best-effort scheduler must not
be the only thing standing between a finished war and a live paint endpoint.
Both transitions are guarded on the status they expect, so concurrent callers
produce one winner and one no-op."
```

---

---

### Task 6: Reading the canvas


**Files:**
- Create: `src/lib/canvas/state.ts`, `src/lib/canvas/diff.ts`
- Test: `src/lib/canvas/__tests__/state.test.ts`, `src/lib/canvas/__tests__/diff.test.ts`, `src/lib/canvas/__tests__/fixtures.ts`

**Interfaces:**
- Consumes: `query`, `queryOne`, `execute` from `db.ts`; `War` from `wars/lifecycle.ts`.
- Produces:
  - `canvasBytes(war: War): Promise<{ seq: number; bytes: Uint8Array }>` from `state.ts`
  - type `DiffResult = { resync: false; seq: number; changes: [number, number][] } | { resync: true; seq: number }`
  - `changesSince(war: War, since: number): Promise<DiffResult>` from `diff.ts`
  - test fixture `makeWar(overrides?)`, `makeToken(warId, colourSlot)`, `paintRaw(warId, idx, tokenId, colourSlot, seq)` from `fixtures.ts`

- [ ] **Step 1: Write the fixtures**

Create `src/lib/canvas/__tests__/fixtures.ts`:

```ts
import { randomUUID } from "node:crypto";
import { execute } from "../../db";
import { warById } from "../../wars/lifecycle";
import type { War } from "../../wars/lifecycle";

export async function makeWar(overrides: Partial<{ width: number; height: number; cooldownSeconds: number; status: string; startsAt: Date; endsAt: Date }> = {}): Promise<War> {
  const id = randomUUID();
  await execute(
    `INSERT INTO wars (id, slug, title, status, width, height, entry_price_usd, cooldown_seconds, starts_at, ends_at)
     VALUES ($1, $1, 'Fixture war', $2, $3, $4, 25, $5, $6, $7)`,
    [
      id,
      overrides.status ?? "live",
      overrides.width ?? 8,
      overrides.height ?? 8,
      overrides.cooldownSeconds ?? 30,
      overrides.startsAt ?? new Date(Date.now() - 3_600_000),
      overrides.endsAt ?? new Date(Date.now() + 3_600_000),
    ],
  );
  return (await warById(id))!;
}

export async function makeToken(warId: string, colourSlot: number): Promise<string> {
  const id = randomUUID();
  await execute(
    `INSERT INTO war_tokens (id, war_id, chain_id, contract, contract_key, colour_slot, status,
                             name, ticker, metadata_fetched_at, reserved_at, joined_at)
     VALUES ($1, $2, 'solana', $1, $1, $3, 'active', $4, $4, now(), now(), now())`,
    [id, warId, colourSlot, `T${colourSlot}`],
  );
  await execute(
    `INSERT INTO token_pixel_counts (war_id, war_token_id) VALUES ($1, $2)`,
    [warId, id],
  );
  return id;
}

/** Writes a pixel straight to the tables, bypassing every rule. Fixtures only. */
export async function paintRaw(
  warId: string,
  idx: number,
  tokenId: string,
  colourSlot: number,
  seq: number,
): Promise<void> {
  await execute(
    `INSERT INTO pixels (war_id, idx, war_token_id, seq, painted_at)
     VALUES ($1, $2, $3, $4, now())
     ON CONFLICT (war_id, idx) DO UPDATE SET war_token_id = $3, seq = $4, painted_at = now()`,
    [warId, idx, tokenId, seq],
  );
  await execute(
    `INSERT INTO pixel_events (war_id, seq, idx, colour_slot, painted_at)
     VALUES ($1, $2, $3, $4, now())`,
    [warId, seq, idx, colourSlot],
  );
  await execute(`UPDATE wars SET last_seq = GREATEST(last_seq, $2) WHERE id = $1`, [warId, seq]);
}
```

- [ ] **Step 2: Write the failing test for the board**

Create `src/lib/canvas/__tests__/state.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { canvasBytes } from "../state";
import { makeToken, makeWar, paintRaw } from "./fixtures";

describe("canvasBytes", () => {
  it("returns an all-zero board for a war nobody has painted", async () => {
    const war = await makeWar({ width: 8, height: 8 });
    const { seq, bytes } = await canvasBytes(war);

    expect(bytes).toHaveLength(64);
    expect(bytes.every((b) => b === 0)).toBe(true);
    expect(seq).toBe(0);
  });

  it("places each pixel at y * width + x with its token's colour slot", async () => {
    const war = await makeWar({ width: 8, height: 8 });
    const red = await makeToken(war.id, 1);
    const blue = await makeToken(war.id, 13);

    await paintRaw(war.id, 0, red, 1, 1); // (0,0)
    await paintRaw(war.id, 8 * 3 + 5, blue, 13, 2); // (5,3)

    const { bytes, seq } = await canvasBytes(war);
    expect(bytes[0]).toBe(1);
    expect(bytes[29]).toBe(13);
    expect(bytes[1]).toBe(0);
    expect(seq).toBe(2);
  });

  it("reflects the latest owner of an overpainted pixel", async () => {
    const war = await makeWar({ width: 4, height: 4 });
    const red = await makeToken(war.id, 1);
    const blue = await makeToken(war.id, 13);

    await paintRaw(war.id, 5, red, 1, 1);
    await paintRaw(war.id, 5, blue, 13, 2);

    const { bytes } = await canvasBytes(war);
    expect(bytes[5]).toBe(13);
  });

  it("never reports a sequence newer than the board it returns", async () => {
    // The seq must be read BEFORE the pixels. Over-delivering a change the
    // client will also see in the diff is harmless — it writes the same value
    // twice. Under-delivering is a pixel the client never learns about.
    const war = await makeWar({ width: 4, height: 4 });
    const red = await makeToken(war.id, 1);
    await paintRaw(war.id, 3, red, 1, 7);

    const { seq, bytes } = await canvasBytes(war);
    expect(seq).toBeLessThanOrEqual(7);
    expect(bytes[3]).toBe(1);
  });
});
```

- [ ] **Step 3: Run it and watch it fail**

Run: `npx vitest run src/lib/canvas/__tests__/state.test.ts`
Expected: FAIL — cannot resolve `../state`.

- [ ] **Step 4: Write `state.ts`**

```ts
import { query, queryOne } from "../db";
import type { War } from "../wars/lifecycle";

/**
 * The whole board, one byte per pixel, value = palette slot, 0 = unpainted.
 *
 * The sequence number is read BEFORE the pixels, and the order matters. Read
 * it after, and a paint landing in between produces a board that is missing a
 * pixel the client will never be told about again — a permanent hole. Read it
 * before, and the worst case is that the board already contains a change the
 * client also receives in its first diff, which writes the same value twice.
 *
 * Over-deliver, never under-deliver.
 */
export async function canvasBytes(war: War): Promise<{ seq: number; bytes: Uint8Array }> {
  const head = await queryOne<{ last_seq: string }>(`SELECT last_seq FROM wars WHERE id = $1`, [
    war.id,
  ]);
  const seq = Number(head?.last_seq ?? 0);

  const rows = await query<{ idx: number; colour_slot: number }>(
    `SELECT p.idx, t.colour_slot
       FROM pixels p
       JOIN war_tokens t ON t.id = p.war_token_id
      WHERE p.war_id = $1`,
    [war.id],
  );

  const bytes = new Uint8Array(war.width * war.height);
  for (const row of rows) bytes[row.idx] = row.colour_slot;

  return { seq, bytes };
}
```

- [ ] **Step 5: Run the tests and watch them pass**

Run: `npx vitest run src/lib/canvas/__tests__/state.test.ts`
Expected: 4 passed.

- [ ] **Step 6: Write the failing test for the diff**

Create `src/lib/canvas/__tests__/diff.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { changesSince } from "../diff";
import { makeToken, makeWar, paintRaw } from "./fixtures";

describe("changesSince", () => {
  it("returns nothing when the client is up to date", async () => {
    const war = await makeWar();
    const red = await makeToken(war.id, 1);
    await paintRaw(war.id, 1, red, 1, 1);

    const result = await changesSince(war, 1);
    expect(result).toEqual({ resync: false, seq: 1, changes: [] });
  });

  it("returns only what happened after the given sequence, in order", async () => {
    const war = await makeWar();
    const red = await makeToken(war.id, 1);
    const blue = await makeToken(war.id, 13);

    await paintRaw(war.id, 1, red, 1, 1);
    await paintRaw(war.id, 2, blue, 13, 2);
    await paintRaw(war.id, 3, red, 1, 3);

    const result = await changesSince(war, 1);
    expect(result).toEqual({
      resync: false,
      seq: 3,
      changes: [
        [2, 13],
        [3, 1],
      ],
    });
  });

  it("asks the client to refetch rather than shipping a quarter of the board", async () => {
    const war = await makeWar();
    const red = await makeToken(war.id, 1);
    for (let seq = 1; seq <= 12; seq++) await paintRaw(war.id, seq, red, 1, seq);

    const result = await changesSince(war, 0, 10);
    expect(result).toEqual({ resync: true, seq: 12 });
  });

  it("is safe against a client that reports a sequence from the future", async () => {
    const war = await makeWar();
    const red = await makeToken(war.id, 1);
    await paintRaw(war.id, 1, red, 1, 1);

    const result = await changesSince(war, 999);
    expect(result).toEqual({ resync: false, seq: 1, changes: [] });
  });

  it("carries the colour of a cleared pixel as slot 0", async () => {
    const war = await makeWar();
    const red = await makeToken(war.id, 1);
    await paintRaw(war.id, 4, red, 1, 1);
    // An admin clearing a rectangle emits slot 0 events, so clients converge
    // through the ordinary diff rather than being told to resync.
    await paintRaw(war.id, 4, red, 0, 2);

    const result = await changesSince(war, 1);
    expect(result).toMatchObject({ changes: [[4, 0]] });
  });
});
```

- [ ] **Step 7: Run it and watch it fail**

Run: `npx vitest run src/lib/canvas/__tests__/diff.test.ts`
Expected: FAIL — cannot resolve `../diff`.

- [ ] **Step 8: Write `diff.ts`**

```ts
import { diffMaxChanges } from "../config";
import { query, queryOne } from "../db";
import type { War } from "../wars/lifecycle";

export type DiffResult =
  | { resync: false; seq: number; changes: [number, number][] }
  | { resync: true; seq: number };

/**
 * Everything that happened after `since`, or an instruction to start over.
 *
 * Beyond a few thousand changes, JSON pairs cost more than the whole board
 * does as bytes, so a client that has been away is told to refetch instead.
 * That is cheaper for both sides and it is also the escape hatch for a client
 * whose sequence we no longer recognise.
 */
export async function changesSince(
  war: War,
  since: number,
  max: number = diffMaxChanges(),
): Promise<DiffResult> {
  const head = await queryOne<{ last_seq: string }>(`SELECT last_seq FROM wars WHERE id = $1`, [
    war.id,
  ]);
  const seq = Number(head?.last_seq ?? 0);

  // A client claiming a sequence we have not reached is not an error worth an
  // error: it has nothing to learn, and telling it so costs one comparison.
  if (since >= seq) return { resync: false, seq, changes: [] };
  if (seq - since > max) return { resync: true, seq };

  const rows = await query<{ idx: number; colour_slot: number }>(
    `SELECT idx, colour_slot FROM pixel_events
      WHERE war_id = $1 AND seq > $2 AND seq <= $3
      ORDER BY seq ASC`,
    [war.id, since, seq],
  );

  return { resync: false, seq, changes: rows.map((row) => [row.idx, row.colour_slot]) };
}
```

- [ ] **Step 9: Run the tests and watch them pass**

Run: `npx vitest run src/lib/canvas/__tests__/`
Expected: 9 passed.

- [ ] **Step 10: Commit**

```bash
git add src/lib/canvas src/lib/canvas/__tests__
git commit -m "Read the board and the diff

canvasBytes reads the sequence before the pixels, so the board can only ever
be ahead of the sequence it reports. The other order leaves permanent holes."
```

---

---

### Task 7: Painting a pixel


**Files:**
- Create: `src/lib/paint/bans.ts`, `src/lib/paint/paint.ts`
- Test: `src/lib/paint/__tests__/paint.test.ts`

**Interfaces:**
- Consumes: `transaction` from `db.ts`; `War` from `wars/lifecycle.ts`; `subnetBurst()` from `config.ts` (Task 3).
- Produces:
  - type `PaintFailure = "war_not_live" | "out_of_bounds" | "unknown_token" | "banned" | "cooldown"`
  - type `PaintResult = { ok: true; seq: number; idx: number; colourSlot: number; cooldownUntil: string } | { ok: false; reason: PaintFailure; message: string; retryAfterSeconds?: number }`
  - `paintPixel(input: { war: War; x: number; y: number; tokenId: string; painterKey: string; ipHash: string; subnetKey: string }): Promise<PaintResult>`
  - `isBanned(client, keys: { painterKey: string; ipHash: string; subnetKey: string }): Promise<boolean>` from `bans.ts`

- [ ] **Step 1: Write the failing test**

Create `src/lib/paint/__tests__/paint.test.ts`:

```ts
import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import { execute, query } from "../../db";
import { warById } from "../../wars/lifecycle";
import { makeToken, makeWar } from "../../canvas/__tests__/fixtures";
import { paintPixel } from "../paint";

const KEYS = { painterKey: "painter-a", ipHash: "ip-a", subnetKey: "subnet-a" };

beforeEach(() => {
  process.env.RATE_LIMIT_SALT = "test-salt";
});

describe("paintPixel", () => {
  it("paints, allocates sequence 1, and reports the cooldown", async () => {
    const war = await makeWar({ width: 8, height: 8, cooldownSeconds: 30 });
    const token = await makeToken(war.id, 5);

    const result = await paintPixel({ war, x: 2, y: 3, tokenId: token, ...KEYS });

    expect(result).toMatchObject({ ok: true, seq: 1, idx: 26, colourSlot: 5 });
    if (!result.ok) throw new Error("unreachable");
    expect(Date.parse(result.cooldownUntil)).toBeGreaterThan(Date.now());
  });

  it("records the pixel, the event, and the count together", async () => {
    const war = await makeWar({ width: 8, height: 8 });
    const token = await makeToken(war.id, 5);
    await paintPixel({ war, x: 0, y: 0, tokenId: token, ...KEYS });

    const [pixel] = await query<{ idx: number; seq: string }>(`SELECT idx, seq FROM pixels`);
    const [event] = await query<{ idx: number; colour_slot: number }>(
      `SELECT idx, colour_slot FROM pixel_events`,
    );
    const [count] = await query<{ owned: number; placed: number }>(
      `SELECT owned, placed FROM token_pixel_counts`,
    );

    expect(pixel).toMatchObject({ idx: 0 });
    expect(event).toMatchObject({ idx: 0, colour_slot: 5 });
    expect(count).toEqual({ owned: 1, placed: 1 });
  });

  it("moves ownership when one token paints over another", async () => {
    const war = await makeWar({ width: 8, height: 8, cooldownSeconds: 0 });
    const red = await makeToken(war.id, 1);
    const blue = await makeToken(war.id, 13);

    await paintPixel({ war, x: 1, y: 1, tokenId: red, ...KEYS });
    await paintPixel({
      war: (await warById(war.id))!,
      x: 1,
      y: 1,
      tokenId: blue,
      painterKey: "painter-b",
      ipHash: "ip-b",
      subnetKey: "subnet-b",
    });

    const counts = await query<{ war_token_id: string; owned: number; placed: number }>(
      `SELECT war_token_id, owned, placed FROM token_pixel_counts ORDER BY war_token_id`,
    );
    const byToken = Object.fromEntries(counts.map((c) => [c.war_token_id, c]));
    expect(byToken[red].owned).toBe(0);
    expect(byToken[red].placed).toBe(1);
    expect(byToken[blue].owned).toBe(1);
  });

  it("refuses a second paint from the same painter inside the cooldown", async () => {
    const war = await makeWar({ cooldownSeconds: 30 });
    const token = await makeToken(war.id, 5);

    await paintPixel({ war, x: 0, y: 0, tokenId: token, ...KEYS });
    const second = await paintPixel({ war, x: 1, y: 0, tokenId: token, ...KEYS });

    expect(second).toMatchObject({ ok: false, reason: "cooldown" });
    if (second.ok) throw new Error("unreachable");
    expect(second.retryAfterSeconds).toBeGreaterThan(0);
    expect(await query(`SELECT 1 FROM pixels`)).toHaveLength(1);
  });

  it("still blocks when the cookie is cleared but the address is the same", async () => {
    const war = await makeWar({ cooldownSeconds: 30 });
    const token = await makeToken(war.id, 5);

    await paintPixel({ war, x: 0, y: 0, tokenId: token, ...KEYS });
    const second = await paintPixel({
      war,
      x: 1,
      y: 0,
      tokenId: token,
      painterKey: "a-brand-new-painter",
      ipHash: KEYS.ipHash,
      subnetKey: KEYS.subnetKey,
    });

    expect(second).toMatchObject({ ok: false, reason: "cooldown" });
  });

  it("still blocks when the address changes but the cookie is the same", async () => {
    const war = await makeWar({ cooldownSeconds: 30 });
    const token = await makeToken(war.id, 5);

    await paintPixel({ war, x: 0, y: 0, tokenId: token, ...KEYS });
    const second = await paintPixel({
      war,
      x: 1,
      y: 0,
      tokenId: token,
      painterKey: KEYS.painterKey,
      ipHash: "a-different-address",
      subnetKey: "a-different-subnet",
    });

    expect(second).toMatchObject({ ok: false, reason: "cooldown" });
  });

  it("lets exactly one of two simultaneous paints from one painter through", async () => {
    const war = await makeWar({ cooldownSeconds: 30 });
    const token = await makeToken(war.id, 5);

    const results = await Promise.all([
      paintPixel({ war, x: 0, y: 0, tokenId: token, ...KEYS }),
      paintPixel({ war, x: 1, y: 0, tokenId: token, ...KEYS }),
    ]);

    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(await query(`SELECT 1 FROM pixels`)).toHaveLength(1);
  });

  it("hands out a gapless sequence under concurrency", async () => {
    const war = await makeWar({ width: 32, height: 32, cooldownSeconds: 0 });
    const token = await makeToken(war.id, 5);

    await Promise.all(
      Array.from({ length: 20 }, (_, i) =>
        paintPixel({
          war,
          x: i,
          y: 0,
          tokenId: token,
          painterKey: `painter-${i}`,
          ipHash: `ip-${i}`,
          subnetKey: `subnet-${i}`,
        }),
      ),
    );

    const rows = await query<{ seq: string }>(`SELECT seq FROM pixel_events ORDER BY seq`);
    expect(rows.map((r) => Number(r.seq))).toEqual(Array.from({ length: 20 }, (_, i) => i + 1));
  });

  it("refuses a token that belongs to another war", async () => {
    const war = await makeWar();
    const other = await makeWar();
    const foreign = await makeToken(other.id, 5);

    const result = await paintPixel({ war, x: 0, y: 0, tokenId: foreign, ...KEYS });
    expect(result).toMatchObject({ ok: false, reason: "unknown_token" });
  });

  it("refuses a token that has reserved a colour but not paid", async () => {
    const war = await makeWar();
    const token = await makeToken(war.id, 5);
    await execute(`UPDATE war_tokens SET status = 'reserved' WHERE id = $1`, [token]);

    const result = await paintPixel({ war, x: 0, y: 0, tokenId: token, ...KEYS });
    expect(result).toMatchObject({ ok: false, reason: "unknown_token" });
  });

  it("refuses coordinates outside the board", async () => {
    const war = await makeWar({ width: 8, height: 8 });
    const token = await makeToken(war.id, 5);

    for (const [x, y] of [[-1, 0], [0, -1], [8, 0], [0, 8], [1.5, 0]]) {
      const result = await paintPixel({ war, x, y, tokenId: token, ...KEYS });
      expect(result).toMatchObject({ ok: false, reason: "out_of_bounds" });
    }
  });

  it("refuses to paint on a war that has already ended", async () => {
    const war = await makeWar({
      status: "ended",
      startsAt: new Date(Date.now() - 7_200_000),
      endsAt: new Date(Date.now() - 3_600_000),
    });
    const token = await makeToken(war.id, 5);

    const result = await paintPixel({ war, x: 0, y: 0, tokenId: token, ...KEYS });
    expect(result).toMatchObject({ ok: false, reason: "war_not_live" });
  });

  it("refuses a banned painter, and leaves no trace of the attempt", async () => {
    const war = await makeWar();
    const token = await makeToken(war.id, 5);
    await execute(
      `INSERT INTO bans (id, key_type, key, actor) VALUES ($1, 'painter', $2, 'test')`,
      [randomUUID(), KEYS.painterKey],
    );

    const result = await paintPixel({ war, x: 0, y: 0, tokenId: token, ...KEYS });
    expect(result).toMatchObject({ ok: false, reason: "banned" });
    expect(await query(`SELECT 1 FROM pixels`)).toHaveLength(0);
    // A ban must not burn the cooldown row either; nothing about a banned
    // caller should be recorded per attempt.
    expect(await query(`SELECT 1 FROM paint_cooldowns`)).toHaveLength(0);
  });

  it("ignores a ban that has already expired", async () => {
    const war = await makeWar();
    const token = await makeToken(war.id, 5);
    await execute(
      `INSERT INTO bans (id, key_type, key, actor, expires_at)
       VALUES ($1, 'painter', $2, 'test', now() - interval '1 hour')`,
      [randomUUID(), KEYS.painterKey],
    );

    expect(await paintPixel({ war, x: 0, y: 0, tokenId: token, ...KEYS })).toMatchObject({
      ok: true,
    });
  });

  it("caps a subnet's burst even when every painter behind it is new", async () => {
    process.env.PAINT_SUBNET_BURST = "3";
    process.env.PAINT_SUBNET_WINDOW_SECONDS = "60";
    const war = await makeWar({ width: 32, height: 32, cooldownSeconds: 0 });
    const token = await makeToken(war.id, 5);

    const results = [];
    for (let i = 0; i < 5; i++) {
      results.push(
        await paintPixel({
          war,
          x: i,
          y: 0,
          tokenId: token,
          painterKey: `painter-${i}`,
          ipHash: `ip-${i}`,
          subnetKey: "one-shared-subnet",
        }),
      );
    }

    expect(results.filter((r) => r.ok)).toHaveLength(3);
    expect(results[4]).toMatchObject({ ok: false, reason: "cooldown" });
    delete process.env.PAINT_SUBNET_BURST;
    delete process.env.PAINT_SUBNET_WINDOW_SECONDS;
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npx vitest run src/lib/paint/__tests__/paint.test.ts`
Expected: FAIL — cannot resolve `../paint`.

- [ ] **Step 3: Write `bans.ts`**

```ts
import type { PoolClient } from "pg";

/**
 * Checked before anything is written, so a banned caller leaves no row behind —
 * not a pixel, not a cooldown, not an event. An attempt that records something
 * is an attempt that tells the attacker they exist.
 */
export async function isBanned(
  client: PoolClient,
  keys: { painterKey: string; ipHash: string; subnetKey: string },
): Promise<boolean> {
  const result = await client.query(
    `SELECT 1 FROM bans
      WHERE (expires_at IS NULL OR expires_at > now())
        AND ( (key_type = 'painter' AND key = $1)
           OR (key_type = 'ip'      AND key = $2)
           OR (key_type = 'subnet'  AND key = $3) )
      LIMIT 1`,
    [keys.painterKey, keys.ipHash, keys.subnetKey],
  );
  return (result.rowCount ?? 0) > 0;
}
```

- [ ] **Step 4: Write `paint.ts`**

```ts
import type { PoolClient } from "pg";
import { subnetBurst } from "../config";
import { transaction } from "../db";
import type { War } from "../wars/lifecycle";
import { isBanned } from "./bans";

/**
 * One pixel, one transaction.
 *
 * Everything that decides whether a paint is allowed happens inside it: the
 * war's own clock, the bans, the cooldowns, the sequence allocation and the
 * counts. Any check made outside is a check a second request can race past.
 */

export type PaintFailure =
  | "war_not_live"
  | "out_of_bounds"
  | "unknown_token"
  | "banned"
  | "cooldown";

export type PaintResult =
  | { ok: true; seq: number; idx: number; colourSlot: number; cooldownUntil: string }
  | { ok: false; reason: PaintFailure; message: string; retryAfterSeconds?: number };

export type PaintInput = {
  war: War;
  x: number;
  y: number;
  tokenId: string;
  painterKey: string;
  ipHash: string;
  subnetKey: string;
};

/**
 * Takes one cooldown key. Returns false when the caller must wait.
 *
 * The condition lives in the UPDATE's WHERE clause rather than in a SELECT
 * followed by an UPDATE, so two concurrent paints cannot both read "clear" and
 * both proceed — the second one updates zero rows and loses.
 */
async function takeInterval(
  client: PoolClient,
  warId: string,
  keyType: "painter" | "ip",
  key: string,
  seconds: number,
): Promise<boolean> {
  const result = await client.query(
    `INSERT INTO paint_cooldowns AS c (war_id, key_type, key, last_painted_at, window_start, window_count)
     VALUES ($1, $2, $3, now(), now(), 1)
     ON CONFLICT (war_id, key_type, key) DO UPDATE
       SET last_painted_at = now(), window_count = c.window_count + 1
       WHERE c.last_painted_at <= now() - ($4 || ' seconds')::interval
     RETURNING last_painted_at`,
    [warId, keyType, key, String(seconds)],
  );
  return (result.rowCount ?? 0) > 0;
}

/** The subnet key is gated on a count per window, not on an interval. */
async function takeBurst(
  client: PoolClient,
  warId: string,
  key: string,
): Promise<boolean> {
  const { cap, windowSeconds } = subnetBurst();
  const result = await client.query(
    `INSERT INTO paint_cooldowns AS c (war_id, key_type, key, last_painted_at, window_start, window_count)
     VALUES ($1, 'subnet', $2, now(), now(), 1)
     ON CONFLICT (war_id, key_type, key) DO UPDATE
       SET last_painted_at = now(),
           window_start = CASE WHEN c.window_start <= now() - ($3 || ' seconds')::interval
                               THEN now() ELSE c.window_start END,
           window_count = CASE WHEN c.window_start <= now() - ($3 || ' seconds')::interval
                               THEN 1 ELSE c.window_count + 1 END
       WHERE c.window_start <= now() - ($3 || ' seconds')::interval OR c.window_count < $4
     RETURNING window_count`,
    [warId, key, String(windowSeconds), cap],
  );
  return (result.rowCount ?? 0) > 0;
}

async function secondsUntilFree(
  client: PoolClient,
  warId: string,
  painterKey: string,
  ipHash: string,
  cooldownSeconds: number,
): Promise<number> {
  const result = await client.query<{ wait: string }>(
    `SELECT MAX(EXTRACT(EPOCH FROM (last_painted_at + ($4 || ' seconds')::interval - now()))) AS wait
       FROM paint_cooldowns
      WHERE war_id = $1 AND ((key_type = 'painter' AND key = $2) OR (key_type = 'ip' AND key = $3))`,
    [warId, painterKey, ipHash, String(cooldownSeconds)],
  );
  return Math.max(1, Math.ceil(Number(result.rows[0]?.wait ?? 1)));
}

export async function paintPixel(input: PaintInput): Promise<PaintResult> {
  const { war, x, y, tokenId, painterKey, ipHash, subnetKey } = input;

  if (
    !Number.isInteger(x) ||
    !Number.isInteger(y) ||
    x < 0 ||
    y < 0 ||
    x >= war.width ||
    y >= war.height
  ) {
    return { ok: false, reason: "out_of_bounds", message: "That pixel is not on the board." };
  }

  const idx = y * war.width + x;

  return transaction(async (client) => {
    // The war's own clock, read inside the transaction: a war that ended while
    // the request was in flight must not accept this paint.
    const warRow = await client.query<{ status: string; ended: boolean; cooldown_seconds: number }>(
      `SELECT status, (ends_at <= now()) AS ended, cooldown_seconds FROM wars WHERE id = $1`,
      [war.id],
    );
    const current = warRow.rows[0];
    if (!current || current.status !== "live" || current.ended) {
      return {
        ok: false,
        reason: "war_not_live" as const,
        message: "This war is not accepting pixels.",
      };
    }

    if (await isBanned(client, { painterKey, ipHash, subnetKey })) {
      return { ok: false, reason: "banned" as const, message: "You cannot paint in this war." };
    }

    const token = await client.query<{ colour_slot: number }>(
      `SELECT colour_slot FROM war_tokens
        WHERE id = $1 AND war_id = $2 AND status = 'active'`,
      [tokenId, war.id],
    );
    if (token.rowCount === 0) {
      return {
        ok: false,
        reason: "unknown_token" as const,
        message: "That token is not in this war.",
      };
    }
    const colourSlot = token.rows[0].colour_slot;

    // Always painter, then ip, then subnet. A fixed order means two concurrent
    // paints can never hold one key each and wait on the other.
    const cooldown = current.cooldown_seconds;
    if (
      !(await takeInterval(client, war.id, "painter", painterKey, cooldown)) ||
      !(await takeInterval(client, war.id, "ip", ipHash, cooldown)) ||
      !(await takeBurst(client, war.id, subnetKey))
    ) {
      const wait = await secondsUntilFree(client, war.id, painterKey, ipHash, cooldown);
      // Roll back: a refused paint must not leave a half-taken cooldown behind.
      throw new CooldownError(wait);
    }

    const seqRow = await client.query<{ last_seq: string }>(
      `UPDATE wars SET last_seq = last_seq + 1 WHERE id = $1 RETURNING last_seq`,
      [war.id],
    );
    const seq = Number(seqRow.rows[0].last_seq);

    const previous = await client.query<{ war_token_id: string }>(
      `SELECT war_token_id FROM pixels WHERE war_id = $1 AND idx = $2`,
      [war.id, idx],
    );

    await client.query(
      `INSERT INTO pixels (war_id, idx, war_token_id, seq, painted_at, painter_key, ip_hash)
       VALUES ($1, $2, $3, $4, now(), $5, $6)
       ON CONFLICT (war_id, idx) DO UPDATE
         SET war_token_id = $3, seq = $4, painted_at = now(), painter_key = $5, ip_hash = $6`,
      [war.id, idx, tokenId, seq, painterKey, ipHash],
    );

    await client.query(
      `INSERT INTO pixel_events (war_id, seq, idx, colour_slot, painted_at)
       VALUES ($1, $2, $3, $4, now())`,
      [war.id, seq, idx, colourSlot],
    );

    const previousOwner = previous.rows[0]?.war_token_id;
    if (previousOwner && previousOwner !== tokenId) {
      await client.query(
        `UPDATE token_pixel_counts SET owned = GREATEST(0, owned - 1)
          WHERE war_id = $1 AND war_token_id = $2`,
        [war.id, previousOwner],
      );
    }

    await client.query(
      `INSERT INTO token_pixel_counts (war_id, war_token_id, owned, placed)
       VALUES ($1, $2, 1, 1)
       ON CONFLICT (war_id, war_token_id) DO UPDATE
         SET owned = token_pixel_counts.owned + $3, placed = token_pixel_counts.placed + 1`,
      [war.id, tokenId, previousOwner === tokenId ? 0 : 1],
    );

    return {
      ok: true as const,
      seq,
      idx,
      colourSlot,
      cooldownUntil: new Date(Date.now() + cooldown * 1000).toISOString(),
    };
  }).catch((error: unknown) => {
    if (error instanceof CooldownError) {
      return {
        ok: false as const,
        reason: "cooldown" as const,
        retryAfterSeconds: error.retryAfterSeconds,
        message: `Wait ${error.retryAfterSeconds} second${error.retryAfterSeconds === 1 ? "" : "s"} before painting again.`,
      };
    }
    throw error;
  });
}

/** Thrown to roll the transaction back; translated to a result by the caller. */
class CooldownError extends Error {
  constructor(readonly retryAfterSeconds: number) {
    super("cooldown");
    this.name = "CooldownError";
  }
}
```

- [ ] **Step 5: Run the tests and watch them pass**

Run: `npx vitest run src/lib/paint/__tests__/paint.test.ts`
Expected: 15 passed.

If the concurrency test is flaky, that is a real finding and not a flaky test:
it means two paints obtained the same sequence number. Do not add a retry —
find out which statement let both through.

- [ ] **Step 6: Run the whole suite**

Run: `npm test`
Expected: all green.

- [ ] **Step 7: Commit**

```bash
git add src/lib/paint/paint.ts src/lib/paint/bans.ts src/lib/paint/__tests__/paint.test.ts
git commit -m "Paint a pixel

The cooldown condition lives in the UPDATE's WHERE clause, so two concurrent
paints cannot both read 'clear' and both proceed. The sequence is allocated by
incrementing the war row inside the same transaction, which is what makes it
gapless — and a gapless sequence is what makes ?since= polling safe."
```

---

---

### Task 8: The HTTP endpoints


**Files:**
- Create: `src/app/api/session/route.ts`, `src/app/api/canvas/route.ts`, `src/app/api/diff/route.ts`, `src/app/api/paint/route.ts`, `src/app/api/leaderboard/route.ts`, `src/lib/http.ts`
- Test: `src/app/api/__tests__/routes.test.ts`

**Interfaces:**
- Consumes: everything from Tasks 3, 5, 6 and 7.
- Produces:
  - `identify(request: Request): { ok: true; painterKey: string; ipHash: string; subnetKey: string; setCookie?: string } | { ok: false; message: string }` from `src/lib/http.ts`
  - `json(body, init?)` and `noStore` header helpers from `src/lib/http.ts`
  - HTTP contract:
    - `GET /api/session` → `{ cooldownUntil: string | null }`, sets `pw_painter`
    - `GET /api/canvas?war=<slug>` → `application/octet-stream`, headers `X-Canvas-Seq`, `X-Canvas-Width`, `X-Canvas-Height`
    - `GET /api/diff?war=<slug>&since=<n>` → `{ seq, changes }` or `{ resync: true, seq }`
    - `POST /api/paint` `{ warSlug, x, y, tokenId }` → 200 `{ seq, idx, colourSlot, cooldownUntil }` | 409 | 429 | 400
    - `GET /api/leaderboard?war=<slug>` → `{ tokens: [{ id, ticker, name, colourSlot, owned, placed }] }`

- [ ] **Step 1: Write the failing test**

Create `src/app/api/__tests__/routes.test.ts`. Route handlers are plain
functions taking a `Request`, so they are testable without a server:

```ts
import { describe, expect, it } from "vitest";
import { makeToken, makeWar } from "../../../lib/canvas/__tests__/fixtures";
import { GET as canvasRoute } from "../canvas/route";
import { GET as diffRoute } from "../diff/route";
import { GET as leaderboardRoute } from "../leaderboard/route";
import { POST as paintRoute } from "../paint/route";
import { GET as sessionRoute } from "../session/route";

const HEADERS = { "cf-connecting-ip": "1.2.3.4" };

function get(path: string): Request {
  return new Request(`https://pixelwar.fun${path}`, { headers: HEADERS });
}

function post(path: string, body: unknown, cookie?: string): Request {
  return new Request(`https://pixelwar.fun${path}`, {
    method: "POST",
    headers: { ...HEADERS, "content-type": "application/json", ...(cookie ? { cookie } : {}) },
    body: JSON.stringify(body),
  });
}

/** Pulls the painter cookie out of a Set-Cookie header, for the next request. */
function cookieFrom(response: Response): string {
  const header = response.headers.get("set-cookie")!;
  return header.split(";")[0];
}

describe("GET /api/session", () => {
  it("issues a painter cookie that a script cannot read", async () => {
    const response = await sessionRoute(get("/api/session"));
    const setCookie = response.headers.get("set-cookie")!;
    expect(setCookie).toContain("pw_painter=");
    expect(setCookie).toContain("HttpOnly");
    expect(await response.json()).toEqual({ cooldownUntil: null });
  });

  it("does not replace a cookie the caller already has", async () => {
    const first = await sessionRoute(get("/api/session"));
    const cookie = cookieFrom(first);
    const second = await sessionRoute(
      new Request("https://pixelwar.fun/api/session", { headers: { ...HEADERS, cookie } }),
    );
    expect(second.headers.get("set-cookie")).toBeNull();
  });
});

describe("GET /api/canvas", () => {
  it("returns the board as bytes with the sequence in a header", async () => {
    const war = await makeWar({ width: 8, height: 8 });
    const token = await makeToken(war.id, 7);

    const painted = await paintRoute(post("/api/paint", { warSlug: war.slug, x: 1, y: 1, tokenId: token }));
    expect(painted.status).toBe(200);

    const response = await canvasRoute(get(`/api/canvas?war=${war.slug}`));
    expect(response.headers.get("content-type")).toBe("application/octet-stream");
    expect(response.headers.get("x-canvas-width")).toBe("8");
    expect(response.headers.get("x-canvas-seq")).toBe("1");

    const bytes = new Uint8Array(await response.arrayBuffer());
    expect(bytes).toHaveLength(64);
    expect(bytes[9]).toBe(7);
  });

  it("404s for a war that does not exist", async () => {
    expect((await canvasRoute(get("/api/canvas?war=nope"))).status).toBe(404);
  });
});

describe("GET /api/diff", () => {
  it("returns changes after the given sequence", async () => {
    const war = await makeWar({ width: 8, height: 8, cooldownSeconds: 0 });
    const token = await makeToken(war.id, 3);
    await paintRoute(post("/api/paint", { warSlug: war.slug, x: 0, y: 0, tokenId: token }));

    const response = await diffRoute(get(`/api/diff?war=${war.slug}&since=0`));
    expect(await response.json()).toEqual({ resync: false, seq: 1, changes: [[0, 3]] });
  });

  it("rejects a non-numeric since rather than guessing", async () => {
    const war = await makeWar();
    expect((await diffRoute(get(`/api/diff?war=${war.slug}&since=abc`))).status).toBe(400);
  });
});

describe("POST /api/paint", () => {
  it("paints and answers with the new sequence", async () => {
    const war = await makeWar({ width: 8, height: 8 });
    const token = await makeToken(war.id, 2);

    const response = await paintRoute(post("/api/paint", { warSlug: war.slug, x: 3, y: 4, tokenId: token }));
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ seq: 1, idx: 35, colourSlot: 2 });
  });

  it("answers 429 with Retry-After inside the cooldown", async () => {
    const war = await makeWar({ cooldownSeconds: 30 });
    const token = await makeToken(war.id, 2);

    const first = await paintRoute(post("/api/paint", { warSlug: war.slug, x: 0, y: 0, tokenId: token }));
    const cookie = cookieFrom(first);
    const second = await paintRoute(
      post("/api/paint", { warSlug: war.slug, x: 1, y: 0, tokenId: token }, cookie),
    );

    expect(second.status).toBe(429);
    expect(Number(second.headers.get("retry-after"))).toBeGreaterThan(0);
  });

  it("answers 409 once the war has ended", async () => {
    const war = await makeWar({
      status: "live",
      startsAt: new Date(Date.now() - 7_200_000),
      endsAt: new Date(Date.now() - 1_000),
    });
    const token = await makeToken(war.id, 2);

    const response = await paintRoute(post("/api/paint", { warSlug: war.slug, x: 0, y: 0, tokenId: token }));
    expect(response.status).toBe(409);
  });

  it("rejects a body with the wrong shape", async () => {
    const war = await makeWar();
    for (const body of [{}, { warSlug: war.slug }, { warSlug: war.slug, x: "1", y: 1, tokenId: "t" }]) {
      expect((await paintRoute(post("/api/paint", body))).status).toBe(400);
    }
  });

  it("refuses to paint when no client address can be trusted", async () => {
    delete process.env.ALLOW_UNTRUSTED_CLIENT_IP;
    const war = await makeWar();
    const token = await makeToken(war.id, 2);
    const response = await paintRoute(
      new Request("https://pixelwar.fun/api/paint", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ warSlug: war.slug, x: 0, y: 0, tokenId: token }),
      }),
    );
    expect(response.status).toBe(400);
  });
});

describe("GET /api/leaderboard", () => {
  it("ranks tokens by pixels currently owned", async () => {
    const war = await makeWar({ width: 8, height: 8, cooldownSeconds: 0 });
    const red = await makeToken(war.id, 1);
    const blue = await makeToken(war.id, 13);

    await paintRoute(post("/api/paint", { warSlug: war.slug, x: 0, y: 0, tokenId: blue }));
    await paintRoute(post("/api/paint", { warSlug: war.slug, x: 1, y: 0, tokenId: blue }));
    await paintRoute(post("/api/paint", { warSlug: war.slug, x: 2, y: 0, tokenId: red }));

    const body = await (await leaderboardRoute(get(`/api/leaderboard?war=${war.slug}`))).json();
    expect(body.tokens.map((t: { colourSlot: number }) => t.colourSlot)).toEqual([13, 1]);
    expect(body.tokens[0].owned).toBe(2);
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npx vitest run src/app/api/__tests__/routes.test.ts`
Expected: FAIL — the route modules do not exist.

- [ ] **Step 3: Write `src/lib/http.ts`**

```ts
import { issuePainter, painterSetCookie, readPainter } from "./paint/painter";
import { clientIp, hashIp, subnetKey } from "./paint/client-ip";

/**
 * Who is calling, in one place.
 *
 * Fails closed on the address: without a trustworthy one there is no rate
 * limit, and a shared bucket for every anonymous caller is either an unlimited
 * allowance or a self-inflicted outage.
 */
export type Caller =
  | { ok: true; painterKey: string; ipHash: string; subnetKey: string; setCookie?: string }
  | { ok: false; message: string };

export function identify(request: Request): Caller {
  const identity = clientIp(request);
  if (!identity.ok) {
    return {
      ok: false,
      message:
        "No trusted client address. Set TRUSTED_PROXY_HOPS to match the deployment, " +
        "or ALLOW_UNTRUSTED_CLIENT_IP=true for local development.",
    };
  }

  const existing = readPainter(request);
  if (existing) {
    return {
      ok: true,
      painterKey: existing,
      ipHash: hashIp(identity.ip),
      subnetKey: subnetKey(identity.ip),
    };
  }

  const issued = issuePainter();
  return {
    ok: true,
    painterKey: issued.painterKey,
    ipHash: hashIp(identity.ip),
    subnetKey: subnetKey(identity.ip),
    setCookie: painterSetCookie(issued.cookieValue),
  };
}

export const NO_STORE = { "cache-control": "no-store" };

export function json(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    ...init,
    headers: { "content-type": "application/json", ...(init.headers ?? {}) },
  });
}
```

- [ ] **Step 4: Write the routes**

`src/app/api/session/route.ts`:

```ts
import { identify, json, NO_STORE } from "../../../lib/http";
import { queryOne } from "../../../lib/db";
import { currentWar } from "../../../lib/wars/lifecycle";

export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
  const caller = identify(request);
  if (!caller.ok) return json({ error: caller.message }, { status: 400, headers: NO_STORE });

  const war = await currentWar();
  let cooldownUntil: string | null = null;

  if (war) {
    const row = await queryOne<{ until: Date }>(
      `SELECT last_painted_at + ($3 || ' seconds')::interval AS until
         FROM paint_cooldowns
        WHERE war_id = $1 AND key_type = 'painter' AND key = $2`,
      [war.id, caller.painterKey, String(war.cooldownSeconds)],
    );
    if (row && row.until.getTime() > Date.now()) cooldownUntil = row.until.toISOString();
  }

  return json(
    { cooldownUntil },
    { headers: { ...NO_STORE, ...(caller.setCookie ? { "set-cookie": caller.setCookie } : {}) } },
  );
}
```

`src/app/api/canvas/route.ts`:

```ts
import { canvasBytes } from "../../../lib/canvas/state";
import { json } from "../../../lib/http";
import { advanceWar, warBySlug } from "../../../lib/wars/lifecycle";

export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
  const slug = new URL(request.url).searchParams.get("war");
  if (!slug) return json({ error: "war is required" }, { status: 400 });

  const found = await warBySlug(slug);
  if (!found) return json({ error: "No such war" }, { status: 404 });

  const war = await advanceWar(found);
  const { seq, bytes } = await canvasBytes(war);

  return new Response(Buffer.from(bytes), {
    headers: {
      "content-type": "application/octet-stream",
      "x-canvas-seq": String(seq),
      "x-canvas-width": String(war.width),
      "x-canvas-height": String(war.height),
      // An ended board cannot change; a live one may, twice a second at most.
      "cache-control":
        war.status === "ended"
          ? "public, max-age=31536000, immutable"
          : "public, s-maxage=2, stale-while-revalidate=8",
    },
  });
}
```

`src/app/api/diff/route.ts`:

```ts
import { changesSince } from "../../../lib/canvas/diff";
import { json } from "../../../lib/http";
import { advanceWar, warBySlug } from "../../../lib/wars/lifecycle";

export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
  const params = new URL(request.url).searchParams;
  const slug = params.get("war");
  const rawSince = params.get("since");
  if (!slug) return json({ error: "war is required" }, { status: 400 });

  const since = Number(rawSince);
  if (rawSince === null || !Number.isInteger(since) || since < 0) {
    return json({ error: "since must be a non-negative integer" }, { status: 400 });
  }

  const found = await warBySlug(slug);
  if (!found) return json({ error: "No such war" }, { status: 404 });

  const result = await changesSince(await advanceWar(found), since);
  return json(result, {
    headers: { "cache-control": "public, s-maxage=1, stale-while-revalidate=2" },
  });
}
```

`src/app/api/paint/route.ts`:

```ts
import { identify, json, NO_STORE } from "../../../lib/http";
import { paintPixel } from "../../../lib/paint/paint";
import { advanceWar, warBySlug } from "../../../lib/wars/lifecycle";

export const dynamic = "force-dynamic";

const STATUS: Record<string, number> = {
  war_not_live: 409,
  cooldown: 429,
  banned: 403,
  unknown_token: 400,
  out_of_bounds: 400,
};

export async function POST(request: Request): Promise<Response> {
  const caller = identify(request);
  if (!caller.ok) return json({ error: caller.message }, { status: 400, headers: NO_STORE });

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return json({ error: "Body must be JSON" }, { status: 400, headers: NO_STORE });
  }

  const { warSlug, x, y, tokenId } = (body ?? {}) as Record<string, unknown>;
  if (
    typeof warSlug !== "string" ||
    typeof tokenId !== "string" ||
    typeof x !== "number" ||
    typeof y !== "number"
  ) {
    return json(
      { error: "warSlug and tokenId must be strings; x and y must be numbers" },
      { status: 400, headers: NO_STORE },
    );
  }

  const found = await warBySlug(warSlug);
  if (!found) return json({ error: "No such war" }, { status: 404, headers: NO_STORE });

  const result = await paintPixel({
    war: await advanceWar(found),
    x,
    y,
    tokenId,
    painterKey: caller.painterKey,
    ipHash: caller.ipHash,
    subnetKey: caller.subnetKey,
  });

  const cookie = caller.setCookie ? { "set-cookie": caller.setCookie } : {};

  if (!result.ok) {
    return json(
      { error: result.message, reason: result.reason },
      {
        status: STATUS[result.reason] ?? 400,
        headers: {
          ...NO_STORE,
          ...cookie,
          ...(result.retryAfterSeconds ? { "retry-after": String(result.retryAfterSeconds) } : {}),
        },
      },
    );
  }

  return json(result, { headers: { ...NO_STORE, ...cookie } });
}
```

`src/app/api/leaderboard/route.ts`:

```ts
import { query } from "../../../lib/db";
import { json } from "../../../lib/http";
import { warBySlug } from "../../../lib/wars/lifecycle";

export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
  const slug = new URL(request.url).searchParams.get("war");
  if (!slug) return json({ error: "war is required" }, { status: 400 });

  const war = await warBySlug(slug);
  if (!war) return json({ error: "No such war" }, { status: 404 });

  const rows = await query<{
    id: string;
    name: string;
    ticker: string;
    colour_slot: number;
    owned: number;
    placed: number;
  }>(
    `SELECT t.id, t.name, t.ticker, t.colour_slot,
            COALESCE(c.owned, 0)  AS owned,
            COALESCE(c.placed, 0) AS placed
       FROM war_tokens t
       LEFT JOIN token_pixel_counts c ON c.war_token_id = t.id
      WHERE t.war_id = $1 AND t.status = 'active'
      ORDER BY owned DESC, t.colour_slot ASC`,
    [war.id],
  );

  return json(
    {
      tokens: rows.map((row) => ({
        id: row.id,
        name: row.name,
        ticker: row.ticker,
        colourSlot: row.colour_slot,
        owned: row.owned,
        placed: row.placed,
      })),
    },
    { headers: { "cache-control": "public, s-maxage=1, stale-while-revalidate=4" } },
  );
}
```

- [ ] **Step 5: Run the tests and watch them pass**

Run: `npx vitest run src/app/api/__tests__/routes.test.ts`
Expected: 12 passed.

- [ ] **Step 6: Run the whole suite and the linter**

Run: `npm test && npm run lint`
Expected: all green.

- [ ] **Step 7: Commit**

```bash
git add src/app/api src/lib/http.ts
git commit -m "Add the canvas endpoints

The board is bytes, the diff is JSON, and paint fails closed when no client
address can be trusted: a shared bucket for every anonymous caller is either an
unlimited allowance or an outage, and neither is a rate limit."
```

---

---

### Task 9: A war to look at


**Files:**
- Create: `scripts/seed-war.mts`
- Modify: `package.json` (add `db:seed`)

**Interfaces:**
- Consumes: the schema from Task 5.
- Produces: `npm run db:seed` — a live war at slug `demo`, six active tokens, cooldown 5 s.

- [ ] **Step 1: Write the seed script**

Create `scripts/seed-war.mts`:

```ts
import { randomUUID } from "node:crypto";
import { Pool } from "pg";

/**
 * A war to develop against.
 *
 * Development only, and it says so out loud rather than trusting the operator
 * to notice: a seeded war carries fake tokens that never paid, and a fake
 * token on the production board is a lie about who is in a war people paid to
 * enter.
 */

if (process.env.NODE_ENV === "production") {
  console.error("Refusing to seed: NODE_ENV is production.");
  process.exit(1);
}

const url = process.env.DATABASE_URL;
if (!url) {
  console.error("DATABASE_URL is not set.");
  process.exit(1);
}

const TOKENS = [
  { ticker: "PEPE", name: "Pepe", slot: 6 },
  { ticker: "WIF", name: "dogwifhat", slot: 13 },
  { ticker: "BONK", name: "Bonk", slot: 3 },
  { ticker: "MOG", name: "Mog Coin", slot: 18 },
  { ticker: "POPCAT", name: "Popcat", slot: 2 },
  { ticker: "GIGA", name: "Gigachad", slot: 24 },
];

const pool = new Pool({ connectionString: url });
const warId = randomUUID();

await pool.query(
  `INSERT INTO wars (id, slug, title, status, entry_price_usd, cooldown_seconds, starts_at, ends_at)
   VALUES ($1, 'demo', 'Demo war', 'live', 25, 5, now() - interval '1 hour', now() + interval '48 hours')
   ON CONFLICT (slug) DO NOTHING`,
  [warId],
);

const { rows } = await pool.query<{ id: string }>(`SELECT id FROM wars WHERE slug = 'demo'`);
const id = rows[0].id;

for (const token of TOKENS) {
  const tokenId = randomUUID();
  await pool.query(
    `INSERT INTO war_tokens (id, war_id, chain_id, contract, contract_key, colour_slot, status,
                             name, ticker, metadata_fetched_at, reserved_at, joined_at)
     VALUES ($1, $2, 'solana', $3, $3, $4, 'active', $5, $6, now(), now(), now())
     ON CONFLICT DO NOTHING`,
    [tokenId, id, `demo-${token.ticker}`, token.slot, token.name, token.ticker],
  );
  await pool.query(
    `INSERT INTO token_pixel_counts (war_id, war_token_id)
     SELECT $1, id FROM war_tokens WHERE war_id = $1 AND contract_key = $2
     ON CONFLICT DO NOTHING`,
    [id, `demo-${token.ticker}`],
  );
}

console.log(`Seeded war 'demo' with ${TOKENS.length} tokens. Cooldown is 5 seconds.`);
await pool.end();
```

Add to `package.json`: `"db:seed": "tsx scripts/seed-war.mts"`.

- [ ] **Step 2: Run it**

Run: `npm run db:seed`
Expected: `Seeded war 'demo' with 6 tokens.`

- [ ] **Step 3: Verify by hand**

```bash
npm run dev &
curl -s -D- 'http://localhost:3000/api/canvas?war=demo' -o /tmp/board.bin | grep -i x-canvas
wc -c /tmp/board.bin   # expect 40000
```

Then paint through the API and confirm the diff carries it:

```bash
TOKEN=$(psql "$DATABASE_URL" -tAc "SELECT id FROM war_tokens WHERE ticker='PEPE'")
curl -s -X POST localhost:3000/api/paint -H 'content-type: application/json' \
  -c /tmp/jar -d "{\"warSlug\":\"demo\",\"x\":10,\"y\":10,\"tokenId\":\"$TOKEN\"}"
curl -s 'http://localhost:3000/api/diff?war=demo&since=0'
```

Expected: the paint returns `seq: 1`, and the diff returns `[[2010, 6]]`.

- [ ] **Step 4: Commit**

```bash
git add scripts/seed-war.mts package.json
git commit -m "Seed a demo war for development

Refuses to run under NODE_ENV=production: a seeded token never paid, and a
token that never paid has no business on a board people bought into."
```

---

---

### Task 10: The war page


**Files:**
- Create: `src/hooks/useCanvasStream.ts`, `src/components/Board.tsx`, `src/components/TokenRail.tsx`, `src/components/PaintButton.tsx`, `src/components/WarHud.tsx`
- Modify: `src/app/page.tsx`, `src/app/globals.css`, `src/app/layout.tsx`

**Interfaces:**
- Consumes: the HTTP contract from Task 8; `BoardImage`, viewport helpers from Task 2; `colourForSlot` from Task 1.
- Produces: a working page at `/`.

- [ ] **Step 1: Write the polling hook**

Create `src/hooks/useCanvasStream.ts`:

```ts
"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { BoardImage } from "../lib/canvas/board-image";

const POLL_MS = 1500;

/**
 * Fetches the board once, then polls the diff.
 *
 * Polling stops while the tab is hidden and resumes with a single catch-up
 * call: a backgrounded tab polling twice a second for an hour is somebody
 * else's bandwidth bill and nobody's benefit.
 */
export function useCanvasStream(warSlug: string) {
  const [image, setImage] = useState<BoardImage | null>(null);
  const [version, setVersion] = useState(0);
  const seq = useRef(0);
  const busy = useRef(false);

  const loadBoard = useCallback(async () => {
    const response = await fetch(`/api/canvas?war=${encodeURIComponent(warSlug)}`);
    if (!response.ok) return;

    const width = Number(response.headers.get("x-canvas-width"));
    const height = Number(response.headers.get("x-canvas-height"));
    seq.current = Number(response.headers.get("x-canvas-seq"));

    const next = new BoardImage(width, height);
    next.setBase(new Uint8Array(await response.arrayBuffer()));
    setImage(next);
    setVersion((v) => v + 1);
  }, [warSlug]);

  const poll = useCallback(async () => {
    if (busy.current || !image) return;
    busy.current = true;
    try {
      const response = await fetch(
        `/api/diff?war=${encodeURIComponent(warSlug)}&since=${seq.current}`,
      );
      if (!response.ok) return;
      const body = await response.json();

      if (body.resync) {
        await loadBoard();
        return;
      }
      if (body.changes.length === 0) {
        seq.current = body.seq;
        return;
      }
      for (const [idx, slot] of body.changes as [number, number][]) image.applyChange(idx, slot);
      seq.current = body.seq;
      setVersion((v) => v + 1);
    } finally {
      busy.current = false;
    }
  }, [image, loadBoard, warSlug]);

  useEffect(() => {
    void loadBoard();
  }, [loadBoard]);

  useEffect(() => {
    if (!image) return;
    let timer: ReturnType<typeof setInterval> | null = null;

    const start = () => {
      if (timer) return;
      void poll();
      timer = setInterval(() => void poll(), POLL_MS);
    };
    const stop = () => {
      if (timer) clearInterval(timer);
      timer = null;
    };
    const onVisibility = () => (document.hidden ? stop() : start());

    start();
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      stop();
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [image, poll]);

  /** Applies our own paint immediately, so the canvas never feels like a form. */
  const applyLocal = useCallback(
    (idx: number, slot: number) => {
      image?.applyChange(idx, slot);
      setVersion((v) => v + 1);
    },
    [image],
  );

  return { image, version, applyLocal, reload: loadBoard };
}
```

- [ ] **Step 2: Write the board component**

Create `src/components/Board.tsx`. It owns the canvas element, the pointer
handling, and nothing else — every calculation comes from `viewport.ts`:

```tsx
"use client";

import { useEffect, useRef, useState } from "react";
import type { BoardImage } from "../lib/canvas/board-image";
import {
  type Viewport,
  clampToBoard,
  isTap,
  panBy,
  pixelAt,
  zoomAt,
} from "../lib/canvas/viewport";

const ZOOM_LIMITS = { min: 1, max: 48 };

export function Board({
  image,
  version,
  onPaint,
  onHover,
}: {
  image: BoardImage;
  version: number;
  onPaint: (x: number, y: number) => void;
  onHover: (point: { x: number; y: number } | null, scale: number) => void;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [viewport, setViewport] = useState<Viewport>({
    centreX: image.width / 2,
    centreY: image.height / 2,
    scale: 3,
  });
  const drag = useRef<{ x: number; y: number; travelled: number } | null>(null);

  // Redraw whenever the board changes or the viewport moves. `version` is the
  // signal: BoardImage mutates in place, so React cannot see it change.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const ratio = window.devicePixelRatio || 1;
    const { clientWidth, clientHeight } = canvas;
    canvas.width = clientWidth * ratio;
    canvas.height = clientHeight * ratio;

    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.imageSmoothingEnabled = false;
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    const source = new ImageData(image.rgbaBuffer, image.width, image.height);
    const bitmapCanvas = document.createElement("canvas");
    bitmapCanvas.width = image.width;
    bitmapCanvas.height = image.height;
    bitmapCanvas.getContext("2d")!.putImageData(source, 0, 0);

    const scale = viewport.scale * ratio;
    ctx.drawImage(
      bitmapCanvas,
      canvas.width / 2 - viewport.centreX * scale,
      canvas.height / 2 - viewport.centreY * scale,
      image.width * scale,
      image.height * scale,
    );
  }, [image, version, viewport]);

  function screen() {
    const canvas = canvasRef.current!;
    return { width: canvas.clientWidth, height: canvas.clientHeight };
  }

  function pointOf(event: React.PointerEvent | React.WheelEvent) {
    const rect = canvasRef.current!.getBoundingClientRect();
    return { x: event.clientX - rect.left, y: event.clientY - rect.top };
  }

  return (
    <canvas
      ref={canvasRef}
      className="h-full w-full touch-none"
      onPointerDown={(event) => {
        event.currentTarget.setPointerCapture(event.pointerId);
        drag.current = { ...pointOf(event), travelled: 0 };
      }}
      onPointerMove={(event) => {
        const point = pointOf(event);
        onHover(pixelAt(viewport, screen(), point, image), viewport.scale);
        if (!drag.current) return;

        const dx = point.x - drag.current.x;
        const dy = point.y - drag.current.y;
        drag.current.travelled += Math.abs(dx) + Math.abs(dy);
        drag.current.x = point.x;
        drag.current.y = point.y;

        setViewport((v) => clampToBoard(panBy(v, -dx / v.scale, -dy / v.scale), image));
      }}
      onPointerUp={(event) => {
        const state = drag.current;
        drag.current = null;
        if (!state || !isTap(state.travelled)) return;

        const pixel = pixelAt(viewport, screen(), pointOf(event), image);
        if (pixel) onPaint(pixel.x, pixel.y);
      }}
      onPointerLeave={() => {
        drag.current = null;
        onHover(null, viewport.scale);
      }}
      onWheel={(event) => {
        const factor = event.deltaY < 0 ? 1.2 : 1 / 1.2;
        setViewport((v) => clampToBoard(zoomAt(v, screen(), pointOf(event), factor, ZOOM_LIMITS), image));
      }}
    />
  );
}
```

- [ ] **Step 3: Write the paint button**

Create `src/components/PaintButton.tsx`. The button *is* the timer:

```tsx
"use client";

import { useEffect, useState } from "react";

/**
 * The cooldown lives inside the button rather than beside it.
 *
 * One control: the reason you cannot paint and the thing you paint with are
 * the same object, so there is no second widget to look for. The interval
 * coarsens above a second because nobody is watching a 30-second countdown
 * frame by frame.
 */
export function PaintButton({
  cooldownUntil,
  disabled,
  label,
  onPaint,
}: {
  cooldownUntil: string | null;
  disabled: boolean;
  label: string;
  onPaint: () => void;
}) {
  const [remaining, setRemaining] = useState(0);

  useEffect(() => {
    if (!cooldownUntil) {
      setRemaining(0);
      return;
    }
    const tick = () => setRemaining(Math.max(0, Date.parse(cooldownUntil) - Date.now()));
    tick();
    const timer = setInterval(tick, remaining > 1000 ? 500 : 100);
    return () => clearInterval(timer);
  }, [cooldownUntil, remaining > 1000]);

  const waiting = remaining > 0;
  const seconds = Math.ceil(remaining / 1000);
  const text = waiting
    ? `${String(Math.floor(seconds / 60)).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`
    : label;

  return (
    <button
      type="button"
      disabled={disabled || waiting}
      onClick={onPaint}
      className="rounded-full px-8 py-3 text-lg font-semibold disabled:opacity-60"
    >
      {text}
    </button>
  );
}
```

- [ ] **Step 4: Write the token rail and the HUD**

Create `src/components/TokenRail.tsx`:

```tsx
"use client";

import { colourForSlot } from "../lib/wars/palette";

export type RailToken = {
  id: string;
  ticker: string;
  name: string;
  colourSlot: number;
  owned: number;
};

export function TokenRail({
  tokens,
  selectedId,
  onSelect,
}: {
  tokens: RailToken[];
  selectedId: string | null;
  onSelect: (id: string) => void;
}) {
  return (
    <ul className="flex gap-2 overflow-x-auto md:flex-col">
      {tokens.map((token, index) => (
        <li key={token.id}>
          <button
            type="button"
            onClick={() => onSelect(token.id)}
            aria-pressed={token.id === selectedId}
            className="flex items-center gap-2 rounded px-2 py-1"
          >
            <span
              aria-hidden
              className="h-4 w-4 rounded-sm"
              style={{ background: colourForSlot(token.colourSlot) }}
            />
            <span className="font-mono">{token.ticker}</span>
            <span className="tabular-nums opacity-70">{token.owned}</span>
            {index < 9 ? <kbd className="opacity-40">{index + 1}</kbd> : null}
          </button>
        </li>
      ))}
    </ul>
  );
}
```

Create `src/components/WarHud.tsx` showing the hovered coordinate, the zoom,
and the time remaining:

```tsx
"use client";

import { useEffect, useState } from "react";

export function WarHud({
  hovered,
  scale,
  endsAt,
}: {
  hovered: { x: number; y: number } | null;
  scale: number;
  endsAt: string;
}) {
  const [remaining, setRemaining] = useState("");

  useEffect(() => {
    const tick = () => {
      const ms = Math.max(0, Date.parse(endsAt) - Date.now());
      const hours = Math.floor(ms / 3_600_000);
      const minutes = Math.floor((ms % 3_600_000) / 60_000);
      const seconds = Math.floor((ms % 60_000) / 1000);
      setRemaining(
        `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`,
      );
    };
    tick();
    const timer = setInterval(tick, 1000);
    return () => clearInterval(timer);
  }, [endsAt]);

  return (
    <div className="pointer-events-none flex justify-between font-mono text-sm">
      <span>{hovered ? `(${hovered.x}, ${hovered.y}) ${scale.toFixed(1)}x` : `${scale.toFixed(1)}x`}</span>
      <span>{remaining} left</span>
    </div>
  );
}
```

- [ ] **Step 5: Wire the page**

Rewrite `src/app/page.tsx` as a server component that loads the war and hands
it to a client shell. Keep the shell in `src/components/WarView.tsx`:

```tsx
import { activeTokens, currentWar } from "../lib/wars/lifecycle";
import { WarView } from "../components/WarView";

export const dynamic = "force-dynamic";

export default async function Page() {
  const war = await currentWar();
  if (!war) {
    return (
      <main className="grid min-h-screen place-items-center p-8 text-center">
        <div>
          <h1 className="text-2xl font-semibold">No war is running.</h1>
          <p className="opacity-70">The next one will appear here when it opens.</p>
        </div>
      </main>
    );
  }

  const tokens = await activeTokens(war.id);

  return (
    <WarView
      war={{
        slug: war.slug,
        title: war.title,
        status: war.status,
        width: war.width,
        height: war.height,
        endsAt: war.endsAt.toISOString(),
      }}
      tokens={tokens.map((token) => ({
        id: token.id,
        ticker: token.ticker,
        name: token.name,
        colourSlot: token.colourSlot,
        owned: 0,
      }))}
    />
  );
}
```

`WarView` holds the client state: selected token, cooldown, hovered pixel. It
calls `/api/session` on mount to get its cookie and its current cooldown, binds
number keys to the first nine tokens, refreshes the leaderboard every two
seconds, and on a successful paint calls `applyLocal` before the next poll
arrives so the pixel appears instantly.

Handle the 429 by reading `Retry-After` and setting `cooldownUntil` from it —
the server is the authority, and the client's prediction is only a guess that
has to yield.

Handle the 409 by rendering the frozen state over the canvas: the war ended
while the tab was open, and a paint button that has quietly stopped working is
worse than a screen that says so.

- [ ] **Step 6: Verify by hand**

```bash
npm run db:up && npm run db:seed && npm run dev
```

Open `http://localhost:3000` and confirm, in order:

1. The board renders as a 200×200 slate square on a page that is not white.
2. Scrolling zooms toward the cursor — whatever is under the pointer stays put.
3. Dragging pans, and releasing after a drag does **not** paint.
4. Picking PEPE and clicking paints one pixel in `#00A368` immediately.
5. The button becomes a countdown for five seconds and refuses clicks.
6. A second browser window shows the new pixel within about 1.5 seconds.
7. Pressing `2` selects the second token in the rail.
8. `(x, y)` and the zoom track the pointer; the time remaining counts down.
9. On a phone-sized viewport, pinch zooms, one finger pans, and a tap paints.

- [ ] **Step 7: Run the whole suite and the linter**

Run: `npm test && npm run lint && npm run build`
Expected: all green.

- [ ] **Step 8: Commit**

```bash
git add src/app src/components src/hooks
git commit -m "Add the war page

The canvas is one element and every calculation behind it is a tested pure
function. Painting applies locally before the next poll arrives, and a 429
overrides the client's guess with the server's answer."
```

---

---

## Batch A is done when

- `npm test` is green, `npm run lint` is clean, `npm run build` succeeds.
- `npm run db:up && npm run db:seed && npm run dev` gives a canvas you can paint on.
- Two browser windows converge within ~1.5 s.
- The cooldown survives clearing cookies (same address) and changing address (same cookie).
- No payments, no wallet, no admin, and no half-built versions of them.

---

## Self-review against the spec

**Covered:** war rows and lifecycle (§1, §9 start/close minus the snapshot),
the palette and slot 0 (§4), the canvas and diff endpoints and the sequence
argument (§6), painting with the cooldown ladder, bans and the subnet cap (§7),
the renderer, viewport, tap threshold, HUD, keyboard shortcuts and cooldown-in-
the-button (§11).

**Deliberately not covered, and which batch takes it:**

| Spec | Batch |
| --- | --- |
| §5 entry and payment, §8 RPC proxy, `entry_orders`, `payments`, `consumed_signatures`, `unmatched_payments` | B |
| §9 snapshot on close, `war_snapshots`, archive pages, share image, frozen-state screen | C |
| §10 admin console, clear rectangle, bans UI, remove token, audit log | D |
| §11 template overlay, pixel inspection, §12 rules page, content reports, §13 headers, §16 deploy and the reconcile cron | E |

`GET /api/pixel` (§6) lands in Batch E with the inspector UI that consumes it;
nothing in Batch A calls it.

**Ordering note.** Tasks 1, 2 and 3 touch no database and run before the Neon
branches exist. Task 4 connects to Neon, and everything from Task 5 on needs
it. That is why the palette, the viewport maths and the painter identity come
first: they are the parts of this batch that a missing connection string
cannot block.

**Type consistency checked:** `War`/`WarToken` shapes are produced in Task 3 and
consumed unchanged in Tasks 5, 6, 7 and 10. `painterKey`/`ipHash`/`subnetKey`
are the same three names from `client-ip.ts` through `identify()` into
`paintPixel`. `colourSlot` is camelCase in TypeScript and `colour_slot` in SQL
everywhere, with the conversion only in the row-mapping functions.

**One correction folded in:** `config.ts` first exported `SUBNET_BURST` and
`DIFF_MAX_CHANGES` as module constants, which freezes the values at import and
makes the burst-cap test unrunnable. They are functions from the start —
`subnetBurst()` and `diffMaxChanges()` — in Task 3, where the file is created.

---

## The remaining batches

Each gets its own plan document, written when the batch starts rather than now:
a plan for Batch D written today would be guessing at names Batch B has not
chosen yet.

- **Batch B — Entry and payment.** `entry_orders` and the payment tables, the
  Solana verifier carried over from bidoor with the payer-pubkey binding added,
  the RPC proxy with its method whitelist, the wallet button, `/join`, and the
  collapsed paste-a-signature fallback. Verifiable by taking a real USDC
  payment on devnet and watching a token turn `active`.
- **Batch C — Closing a war.** Snapshots, the ranking, the frozen-canvas
  screen, `/wars` and `/wars/[slug]`, and the share image. Verifiable by
  setting a demo war's `ends_at` into the past and reloading.
- **Batch D — Admin.** Sessions and lockout from bidoor, war creation and
  scheduling, clear-rectangle, bans, token removal, the audit log.
- **Batch E — Public surface and deploy.** Pixel inspection, template overlay,
  content reports, the rules page, security headers, the reconcile cron and
  `DEPLOY.md`.

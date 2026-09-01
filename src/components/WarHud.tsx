"use client";

import { useEffect, useState } from "react";
import { paramsForViewport, type Size, type Viewport } from "../lib/canvas/viewport";

/**
 * The instrument readout: where the pointer is, how far in, and a link back
 * to here.
 *
 * The countdown used to live here too and does not any more — it moved to
 * `WarClock` in the rail, because a war's ending is the event and this strip
 * is telemetry. What is left is the two numbers that answer "where am I on
 * this board", which is exactly what a readout is for, and now the one action
 * that follows from them.
 *
 * Both numbers are monospaced and tabular (DESIGN.md §3): coordinates that
 * change on every pointer move would otherwise shift this strip's width
 * continuously while somebody is trying to aim.
 */

/** How long the button says it worked before going back to its own name. */
const CONFIRM_MS = 1600;

export function WarHud({
  hovered,
  view,
  board,
}: {
  hovered: { x: number; y: number } | null;
  /**
   * Where the board is looking, and the ONLY source of the zoom.
   *
   * The zoom used to arrive on the hover callback, which made it a fact about
   * the last pointer move rather than about the view. A deep link that opens
   * at 20x fires no pointer event, so the readout said 3.0x until somebody
   * moved the mouse — a number that was simply wrong, on a strip whose entire
   * job is to be right about where you are.
   *
   * Null until the first board has framed itself.
   */
  view: Viewport | null;
  board: Size;
}) {
  return (
    <div className="readout bevel-in flex shrink-0 items-center justify-between gap-2 px-3 py-1.5">
      <span className="numeric text-[12px]">
        {hovered ? `${hovered.x}, ${hovered.y}` : "--, --"}
      </span>
      <span className="flex items-center gap-2">
        <CopyPlaceLink view={view} board={board} />
        <span className="numeric text-[12px]">{view ? `${view.scale.toFixed(1)}x` : "--x"}</span>
      </span>
    </div>
  );
}

/**
 * "Copy link to this place".
 *
 * THE VIEW, NOT THE HOVERED PIXEL. A link built from `hovered` would be dead
 * on every touchscreen, because there is no hover there at all — and a
 * touchscreen is where most people share a link from. What somebody means by
 * "this place" is what is on their screen, which is the viewport.
 *
 * NOT BRASS, and that is a deliberate reading of DESIGN.md I5 rather than an
 * oversight. The invariant says the accent marks an action, and warns that a
 * proposal for a THIRD accent gets argued before it is built ("if everything
 * is brass, nothing is"). This action does not need to win that argument: it
 * is a convenience beside a readout, not one of the two things the product
 * asks people to do. It stays a quiet control.
 *
 * THE FAILURE IS SHOWN, NOT SWALLOWED. `navigator.clipboard` does not exist
 * on an insecure origin and can be refused by permission policy, so the copy
 * genuinely fails sometimes. Saying "Copied" when nothing was copied is worse
 * than saying nothing: the person walks away with an empty clipboard and
 * pastes the wrong thing into a raid channel. It says "Copy failed" and not
 * "Press Cmd-C", which was the first wording and was a lie of a different
 * kind: nothing is selected, so that instruction copies nothing either.
 */
function CopyPlaceLink({ view, board }: { view: Viewport | null; board: Size }) {
  const [state, setState] = useState<"idle" | "copied" | "failed">("idle");

  // One timer, cleared on unmount and on every retry, so a second click does
  // not leave the first click's timeout to reset the label underneath it.
  useEffect(() => {
    if (state === "idle") return;
    const timer = setTimeout(() => setState("idle"), CONFIRM_MS);
    return () => clearTimeout(timer);
  }, [state]);

  async function copy() {
    if (!view) return;
    const params = paramsForViewport(view, board);
    const url = new URL(window.location.href);
    // DELETED THEN SET, IN THIS ORDER, and both halves earn their place.
    // `set` alone keeps an existing key where it already was, so following a
    // link and copying it back produced `?y=&z=&x=` — which works and reads
    // like a bug in something a person is about to paste into a raid channel.
    // Deleting first also means clicking twice can never produce `?x=1&x=2`.
    // Anything else already on the URL is left alone.
    for (const key of ["x", "y", "z"] as const) url.searchParams.delete(key);
    for (const key of ["x", "y", "z"] as const) url.searchParams.set(key, params[key]);

    try {
      await navigator.clipboard.writeText(url.toString());
      setState("copied");
    } catch {
      setState("failed");
    }
  }

  return (
    <button
      type="button"
      onClick={copy}
      // Disabled rather than absent before the first frame, so the strip does
      // not change width the moment the canvas appears.
      disabled={!view}
      // `btn-secondary bevel` is this design's quiet control — the same one
      // "Show territory" wears — rather than a class invented for one button.
      // It sits on the readout surface, and it brings its own
      // `--chrome-control` background, so the readout's blue is not what the
      // label has to be legible against.
      className="btn-secondary bevel px-2 py-0.5 text-[11px]"
      title="Copy a link that opens the board here"
    >
      {/* `aria-live` on the label, not the button: a screen reader should
          hear that the copy happened, and hear it once. */}
      <span aria-live="polite">
        {state === "copied" ? "Copied" : state === "failed" ? "Copy failed" : "Copy link"}
      </span>
    </button>
  );
}

"use client";

import { useId, useRef, useState } from "react";
import { TEMPLATE_MAX_SIDE, clampTemplate, templateTooLarge } from "../lib/canvas/template";
import type { Size } from "../lib/canvas/viewport";

/**
 * The community's own sketch, laid over the board.
 *
 * WHAT IT IS FOR. `docs/references.md` has specified this since before the
 * canvas was built: "for a token community it is the difference between
 * wanting their logo on the canvas and being able to put it there". Both
 * r/place descendants ship one, and on r/place itself the armies were built
 * on unofficial overlay scripts — the mechanic is proven, the only decision
 * left was whether it lives in the product or in a userscript people have to
 * find.
 *
 * ENTIRELY CLIENT-SIDE, AND THAT IS A PROMISE THIS FILE HAS TO KEEP. The
 * image is read from the visitor's own disk into an `ImageBitmap` and handed
 * to the canvas. It is never uploaded, never stored, and does not survive a
 * reload — there is no fetch in this file and no `localStorage` either.
 *
 * The reason is not squeamishness about bytes. An upload would make this a
 * place where strangers put pictures on our infrastructure, which is a
 * moderation surface, a storage bill and a takedown process — for a feature
 * whose entire job is to help one person line up their own drawing. Keeping
 * it in the tab means a community's unpublished plans stay unpublished, and
 * means nothing here can be used to host anything.
 *
 * // ponytail: nothing persists, so a reload costs re-picking the file. If
 * // communities complain, the cheap fix is remembering the PLACEMENT in
 * // localStorage and re-asking for the file — never storing the image.
 */

export type TemplateOverlay = {
  bitmap: ImageBitmap;
  /** Top-left corner, in board cells. May be negative for an oversized template. */
  x: number;
  y: number;
  opacity: number;
};

const DEFAULT_OPACITY = 0.6;

/** A bound on the file itself, before it is ever decoded. */
const MAX_FILE_BYTES = 8 * 1024 * 1024;

export function TemplateControl({
  board,
  template,
  onChange,
}: {
  board: Size;
  template: TemplateOverlay | null;
  onChange: (next: TemplateOverlay | null) => void;
}) {
  const fileId = useId();
  const input = useRef<HTMLInputElement>(null);
  const [error, setError] = useState<string | null>(null);

  async function pick(file: File | undefined) {
    setError(null);
    if (!file) return;

    // Checked before decoding. `createImageBitmap` on an eight-megabyte file
    // is work we do not have to do to know the answer.
    if (file.size > MAX_FILE_BYTES) {
      setError("That file is too big. A template is a small picture.");
      return;
    }

    let bitmap: ImageBitmap;
    try {
      bitmap = await createImageBitmap(file);
    } catch {
      // A file that is not an image, or one the browser will not decode.
      setError("That file is not an image this browser can read.");
      return;
    }

    if (templateTooLarge(bitmap)) {
      // Refused rather than resized: shrinking it would invent the colours in
      // every cell, and a template whose cells are invented is worse than
      // none, because somebody would paint from it.
      bitmap.close();
      setError(`A template is at most ${TEMPLATE_MAX_SIDE} by ${TEMPLATE_MAX_SIDE} pixels.`);
      return;
    }

    // Released here rather than left to the collector: an ImageBitmap holds
    // decoded pixels, and picking six files in a row should not keep six.
    template?.bitmap.close();

    // Centred on the board, which is where somebody is looking, rather than
    // at the origin, which on a 200x200 board is off the edge of the view.
    const at = clampTemplate(
      {
        x: Math.round((board.width - bitmap.width) / 2),
        y: Math.round((board.height - bitmap.height) / 2),
      },
      bitmap,
      board,
    );
    onChange({ bitmap, x: at.x, y: at.y, opacity: template?.opacity ?? DEFAULT_OPACITY });
  }

  function nudge(dx: number, dy: number) {
    if (!template) return;
    const at = clampTemplate({ x: template.x + dx, y: template.y + dy }, template.bitmap, board);
    onChange({ ...template, x: at.x, y: at.y });
  }

  function clear() {
    template?.bitmap.close();
    onChange(null);
    setError(null);
    // Or picking the same file again does nothing: an input with an unchanged
    // value fires no change event.
    if (input.current) input.current.value = "";
  }

  return (
    <section className="flex flex-col gap-1.5">
      <h2 className="section-label">Template</h2>

      {template ? (
        <>
          <p className="muted text-[11px]">
            {template.bitmap.width}x{template.bitmap.height} at {template.x}, {template.y}
          </p>

          {/* Arrow keys would be the obvious binding and are already taken:
              the paint bar traverses swatches with them (DESIGN.md §9). These
              are buttons so they are reachable the same way everything else
              here is. */}
          {/* A D-PAD, IN THE SHAPE OF A D-PAD. This was `↑` on its own row
              and `← → ↓` on the next, which put "down" in the right-hand
              column — the arrows were correct and the arrangement said
              something else. Down goes under, between left and right. */}
          <div className="grid grid-cols-3 gap-1">
            <span />
            <Nudge label="Up" onClick={() => nudge(0, -1)}>↑</Nudge>
            <span />
            <Nudge label="Left" onClick={() => nudge(-1, 0)}>←</Nudge>
            <Nudge label="Down" onClick={() => nudge(0, 1)}>↓</Nudge>
            <Nudge label="Right" onClick={() => nudge(1, 0)}>→</Nudge>
          </div>

          <label className="flex items-center gap-2 text-[11px]">
            <span className="section-label muted">Fade</span>
            <input
              type="range"
              min={10}
              max={100}
              step={5}
              value={Math.round(template.opacity * 100)}
              onChange={(event) =>
                onChange({ ...template, opacity: Number(event.target.value) / 100 })
              }
              className="w-full"
              aria-label="Template opacity"
            />
          </label>

          <button type="button" onClick={clear} className="btn-secondary bevel px-2 py-1 text-[11px]">
            Remove template
          </button>
        </>
      ) : (
        <p className="muted text-[11px]">
          Lay your own picture over the board to paint from. It stays in this tab.
        </p>
      )}

      {/* The input is always mounted and always the same element, so choosing
          a second file replaces the first without the control jumping. */}
      <label htmlFor={fileId} className="btn-secondary bevel cursor-pointer px-2 py-1 text-center text-[11px]">
        {template ? "Choose another" : "Choose a picture"}
      </label>
      <input
        ref={input}
        id={fileId}
        type="file"
        accept="image/*"
        className="sr-only"
        onChange={(event) => void pick(event.target.files?.[0])}
      />

      {error ? (
        <p role="status" className="text-[11px]">
          {error}
        </p>
      ) : null}
    </section>
  );
}

function Nudge({
  label,
  onClick,
  children,
}: {
  label: string;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={`Move template ${label.toLowerCase()} one pixel`}
      className="btn-secondary bevel py-0.5 text-[11px]"
    >
      <span aria-hidden>{children}</span>
    </button>
  );
}

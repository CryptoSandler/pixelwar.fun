"use client";

import { useEffect, useId, useRef, useState } from "react";
import {
  TEMPLATE_MAX_SIDE,
  clampTemplate,
  readStoredTemplate,
  templateDataUrlTooLarge,
  templateTooLarge,
} from "../lib/canvas/template";
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
 * image is read from the visitor's own disk and handed to the canvas. It is
 * never uploaded: there is no fetch in this file, and nothing about the
 * picture reaches a server.
 *
 * The reason is not squeamishness about bytes. An upload would make this a
 * place where strangers put pictures on our infrastructure, which is a
 * moderation surface, a storage bill and a takedown process — for a feature
 * whose entire job is to help one person line up their own drawing. Keeping
 * it in the tab means a community's unpublished plans stay unpublished, and
 * means nothing here can be used to host anything.
 *
 * IT SURVIVES A RELOAD, AND THAT IS WHY `sessionStorage` AND NOT
 * `localStorage`. The first version kept nothing, and a template that
 * vanished on every refresh was the one thing the owner's review failed it
 * on — somebody aligning a drawing reloads, and re-picking the file each time
 * is the feature not working.
 *
 * `sessionStorage` is scoped to the TAB. That keeps the isolation the copy
 * promises: a second tab, a second window and a second person see nothing,
 * and closing the tab takes it with them. `localStorage` would survive all
 * three and turn "your community's unpublished plan" into something left on
 * a shared machine.
 */

export type TemplateOverlay = {
  bitmap: ImageBitmap;
  /** Top-left corner, in board cells. May be negative for an oversized template. */
  x: number;
  y: number;
  opacity: number;
  /**
   * The picture as a data URL, carried so a nudge or a fade can be written
   * back without re-reading the file.
   *
   * Absent only if a future caller constructs an overlay some other way; the
   * control treats that as "nothing to store" rather than as an error.
   */
  dataUrl?: string;
};

const DEFAULT_OPACITY = 0.6;

/** A bound on the file itself, before it is ever decoded. */
const MAX_FILE_BYTES = 8 * 1024 * 1024;

/** One key, per tab. The war is not in it: a template is a drawing, not a plan for one board. */
const STORAGE_KEY = "pixelwar.template";

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
  /**
   * Whether what is on screen will still be there after a reload.
   *
   * FALSE IS A REAL STATE, NOT AN ERROR. `sessionStorage` throws when a
   * browser is in a mode that disables it, when the quota is full of somebody
   * else's data, or when the tab is embedded with storage partitioned away.
   * The template still works — it is already decoded and on the canvas — so
   * refusing it would be worse than showing it. What must not happen is the
   * copy going on promising something the tab can no longer do, which is the
   * exact defect this whole change was opened for.
   */
  const [persisted, setPersisted] = useState(true);
  // Restored once, on mount, and never again: a later run would fight
  // whatever the person has done since.
  const restored = useRef(false);

  /**
   * Brings back the template this tab was using.
   *
   * The bitmap is decoded from the stored data URL rather than kept — an
   * `ImageBitmap` cannot be serialised, and the data URL is the thing that
   * can. `readStoredTemplate` has already refused anything that is not an
   * image data URL, so this decode is the second check rather than the first.
   */
  useEffect(() => {
    if (restored.current) return;
    restored.current = true;

    let cancelled = false;
    void (async () => {
      // The whole restore lives in here, storage read included: a `setState`
      // in an effect's own body is a synchronous render-time write and the
      // lint rule that forbids it is right — this tab's ability to keep a
      // template is something we learn, not something we render from.
      let stored: ReturnType<typeof readStoredTemplate> = null;
      try {
        stored = readStoredTemplate(window.sessionStorage.getItem(STORAGE_KEY), board);
      } catch {
        // Private mode, partitioned storage, quota. Nothing to restore and
        // nothing will be kept, so the copy has to stop promising it.
        if (!cancelled) setPersisted(false);
        return;
      }
      if (!stored || cancelled) return;

      try {
        const blob = await (await fetch(stored.dataUrl)).blob();
        const bitmap = await createImageBitmap(blob);
        if (cancelled) {
          bitmap.close();
          return;
        }
        // Clamped again now the size is known — `readStoredTemplate` could
        // only bound the number, not fit the picture.
        const at = clampTemplate({ x: stored.x, y: stored.y }, bitmap, board);
        // `dataUrl` carried through, or the first nudge after a reload would
        // move the template on screen and save nothing — and the NEXT reload
        // would put it back where it was, which reads as the control being
        // broken rather than as storage being stale.
        onChange({ bitmap, x: at.x, y: at.y, opacity: stored.opacity, dataUrl: stored.dataUrl });
      } catch {
        // A stored value that will not decode is a stored value worth
        // dropping, rather than an error to show somebody who did nothing.
        try {
          window.sessionStorage.removeItem(STORAGE_KEY);
        } catch {
          // Nothing to do: the read already failed for the same reason.
        }
      }
    })();
    return () => {
      cancelled = true;
    };
    // Mount only. `board` and `onChange` are stable for the life of a war,
    // and re-running this would re-restore over somebody's own placement.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /** Writes the current template, or records that this tab cannot keep one. */
  function remember(next: { dataUrl: string; x: number; y: number; opacity: number } | null) {
    try {
      if (next) window.sessionStorage.setItem(STORAGE_KEY, JSON.stringify(next));
      else window.sessionStorage.removeItem(STORAGE_KEY);
      setPersisted(true);
    } catch {
      // Quota, private mode, partitioned storage. The template stays on the
      // canvas; the copy below stops claiming it will come back.
      setPersisted(false);
    }
  }

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

    const dataUrl = await readDataUrl(file);
    // REFUSED BEFORE IT IS ACCEPTED, not when saving later fails. A picture
    // that appears on the board and then does not come back after a reload is
    // precisely the defect this change exists to fix, and quietly accepting
    // something too big to keep would reintroduce it one layer down.
    if (!dataUrl || templateDataUrlTooLarge(dataUrl)) {
      bitmap.close();
      setError("That picture is too heavy to keep for this tab. Save it smaller and try again.");
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
    const opacity = template?.opacity ?? DEFAULT_OPACITY;
    onChange({ bitmap, x: at.x, y: at.y, opacity, dataUrl });
    remember({ dataUrl, x: at.x, y: at.y, opacity });
  }

  function nudge(dx: number, dy: number) {
    if (!template) return;
    const at = clampTemplate({ x: template.x + dx, y: template.y + dy }, template.bitmap, board);
    onChange({ ...template, x: at.x, y: at.y });
    if (template.dataUrl) {
      remember({ dataUrl: template.dataUrl, x: at.x, y: at.y, opacity: template.opacity });
    }
  }

  function fade(opacity: number) {
    if (!template) return;
    onChange({ ...template, opacity });
    if (template.dataUrl) {
      remember({ dataUrl: template.dataUrl, x: template.x, y: template.y, opacity });
    }
  }

  function clear() {
    template?.bitmap.close();
    onChange(null);
    setError(null);
    remember(null);
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
          {/* Said where it matters — beside the template, while it is on
              screen — rather than only in the placeholder nobody sees once
              they have picked a file. */}
          {persisted ? null : (
            <p role="status" className="text-[11px]">
              This tab cannot keep it: it will be gone if you reload.
            </p>
          )}

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
              onChange={(event) => fade(Number(event.target.value) / 100)}
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
          Lay your own picture over the board to paint from.{" "}
          {/*
            THE COPY IS THE THING THAT FAILED REVIEW, so it says exactly what
            happens and no more. It used to read "It stays in this tab", which
            was true about isolation and false about time — the picture did not
            survive a refresh, and somebody aligning a drawing refreshes.

            The fallback wording is NOT "until you close it". When storage is
            unavailable the template lives in memory, so it is gone on the next
            RELOAD, not on the next close — and "until you close it" would be
            the same shape of overpromise one notch smaller, which is the
            mistake this line is here to stop repeating.
          */}
          {persisted
            ? "It stays in this tab, and survives a reload. Closing the tab takes it with you."
            : "This tab cannot keep it, so it stays until you reload."}
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

/** The file as a data URL, or null if the browser will not read it. */
function readDataUrl(file: File): Promise<string | null> {
  return new Promise((resolve) => {
    const reader = new FileReader();
    reader.onload = () => resolve(typeof reader.result === "string" ? reader.result : null);
    reader.onerror = () => resolve(null);
    reader.readAsDataURL(file);
  });
}

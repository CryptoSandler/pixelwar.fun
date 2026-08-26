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
 *
 * `layer` picks which board this is watching — the painted colours, or who
 * owns what. Both are 40,000 bytes and only one is ever in flight, which is
 * the whole reason attribution is a second layer rather than a second byte
 * on every pixel (see `canvas/state.ts`). Switching layers refetches from
 * scratch: `loadBoard` and `poll` both depend on it, so the effects below
 * tear down and re-run, and `seq` is re-read from the new board's own header
 * rather than carried across. Carrying it across is the bug this avoids — a
 * client that kept its sequence would apply the new layer's diffs on top of
 * the old layer's pixels and show a board that never existed.
 */
export function useCanvasStream(warSlug: string, layer: "colour" | "token" = "colour") {
  const [image, setImage] = useState<BoardImage | null>(null);
  const [version, setVersion] = useState(0);
  const seq = useRef(0);
  const busy = useRef(false);

  const loadBoard = useCallback(async () => {
    const response = await fetch(
      `/api/canvas?war=${encodeURIComponent(warSlug)}&layer=${layer}`,
    );
    if (!response.ok) return;

    const width = Number(response.headers.get("x-canvas-width"));
    const height = Number(response.headers.get("x-canvas-height"));
    seq.current = Number(response.headers.get("x-canvas-seq"));

    const next = new BoardImage(width, height);
    next.setBase(new Uint8Array(await response.arrayBuffer()));
    setImage(next);
    setVersion((v) => v + 1);
  }, [warSlug, layer]);

  const poll = useCallback(async () => {
    if (busy.current || !image) return;
    busy.current = true;
    try {
      const response = await fetch(
        `/api/diff?war=${encodeURIComponent(warSlug)}&since=${seq.current}&layer=${layer}`,
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
  }, [image, loadBoard, warSlug, layer]);

  useEffect(() => {
    // The rule can't see that loadBoard's setState calls sit behind an
    // `await fetch`, not synchronously in the effect body; this is the
    // standard "load once on mount" effect, not a cascading-render bug.
    // eslint-disable-next-line react-hooks/set-state-in-effect
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

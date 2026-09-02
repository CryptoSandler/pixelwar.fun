"use client";

import { useEffect, useState } from "react";
import { Board } from "./Board";
import { BoardImage } from "../lib/canvas/board-image";
import { rgba } from "../lib/wars/palette";

/**
 * A finished board, read-only.
 *
 * REUSES `Board` WITH ITS CALLBACKS MADE NO-OPS rather than growing a second
 * renderer: every pixel of the zoom, pan, pinch and device-pixel-grid work
 * already lives there, and a copy would drift from it. Painting is refused by
 * the server for an ended war anyway — this only stops the click being
 * offered. DESIGN.md §5a says so in as many words.
 *
 * ITS OWN FILE AS OF THE ARCHIVE. It was a private function inside
 * `Intermission`, which was correct while the intermission was the only screen
 * that could show a board nobody may paint on. `/wars/[slug]` is the second,
 * and a second copy of a fetch-then-decode-then-mount sequence is how two
 * screens end up disagreeing about what a board looks like when the fetch
 * fails.
 *
 * The deep link still works: `Board` reads the URL itself, so a link to a
 * place in a war frames that place on the war's own result page too.
 */
export function FrozenBoard({
  slug,
  width,
  height,
}: {
  slug: string;
  width: number;
  height: number;
}) {
  const [image, setImage] = useState<BoardImage | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    fetch(`/api/canvas?war=${encodeURIComponent(slug)}`)
      .then((response) => (response.ok ? response.arrayBuffer() : null))
      .then((bytes) => {
        if (cancelled) return;
        if (!bytes) {
          setFailed(true);
          return;
        }
        const next = new BoardImage(width, height, rgba());
        next.setBase(new Uint8Array(bytes));
        setImage(next);
      })
      .catch(() => {
        if (!cancelled) setFailed(true);
      });
    return () => {
      cancelled = true;
    };
  }, [slug, width, height]);

  if (!image) {
    return (
      <div className="grid h-full place-items-center px-6 text-center text-[13px] text-[var(--chrome-ink-inverse)]">
        {/*
          A FAILED FETCH SAYS SO, and this is the half the intermission's
          version was missing: it left "Loading the board..." on screen
          forever, so a 404 and a slow network were the same screen. The
          share card is still correct in that case — it is rendered on the
          server — which makes a spinner that never stops the one state nobody would
          think to check.
        */}
        {failed ? "This board could not be loaded." : "Loading the board..."}
      </div>
    );
  }

  return (
    <Board
      image={image}
      version={1}
      onPaint={() => {}}
      onHover={() => {}}
      onView={() => {}}
      // No template on a finished board: there is nothing left to paint from
      // it, and the result is the thing being shown.
      template={null}
    />
  );
}

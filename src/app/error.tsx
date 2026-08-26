"use client";

import { useEffect } from "react";
import Link from "next/link";
import { Cabinet } from "../components/Cabinet";

/**
 * The boundary for the board, which had none.
 *
 * `join/error.tsx` was the only one in the tree, so everything the board route
 * can throw — a war row that cannot be read, a canvas the stream hands back
 * malformed, anything at all during the render of a page that polls two
 * endpoints every two seconds — fell through to Next's default error page.
 * That page says nothing about what a visitor is looking at and offers no way
 * back to the war.
 *
 * `retry` is the prop's name in Next 16; `reset` was the Pages-era spelling
 * and is not what this version passes. Confirmed against
 * `next/dist/docs/01-app/03-api-reference/03-file-conventions/error.md` in
 * the installed package rather than from memory.
 *
 * It does not wrap the root layout above it — that is `global-error.js`'s job
 * and there is nothing in the layout that throws.
 */
export default function BoardError({
  error,
  retry,
}: {
  error: Error & { digest?: string };
  retry: () => void;
}) {
  useEffect(() => {
    console.error("board:", error);
  }, [error]);

  return (
    <Cabinet label="Board">
      <section className="panel bevel flex flex-col items-start gap-3 p-6">
        <h1 className="text-[20px] font-medium">The board could not be shown.</h1>
        <p className="muted text-[13px]">
          The war itself is unaffected — this is the page failing to draw, not the canvas. Painting
          is free and every pixel on the board can be painted over by anyone, so nothing is decided
          by a screen that did not load.
        </p>
        <div className="flex flex-wrap gap-2">
          <button type="button" className="btn-secondary px-4 py-2" onClick={() => retry()}>
            Try again
          </button>
          <Link className="btn-secondary px-4 py-2" href="/join">
            Add your token
          </Link>
        </div>
      </section>
    </Cabinet>
  );
}

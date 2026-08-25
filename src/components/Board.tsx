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
  // Every pointer currently down, by id. One entry: a mouse drag or a single
  // finger. Two: a pinch. `drag` above tracks only the single-pointer case;
  // once a second pointer joins, panning stops and `pinch` below takes over
  // so the two gestures never write to the same state at once.
  const pointers = useRef<Map<number, { x: number; y: number }>>(new Map());
  const pinch = useRef<{ distance: number } | null>(null);
  // True for the rest of a gesture the moment a second pointer joins it, even
  // after that pointer lifts again. A pinch that ends with one finger still
  // down must never be mistaken for the tap that finger's own pointerup
  // would otherwise look like.
  const wasMultiTouch = useRef(false);
  // Bumped by the ResizeObserver below. The draw effect's own deps only ever
  // see the board and the viewport move — nothing tells it the element's own
  // box changed size, so without this the backing store keeps whatever
  // dimensions it had at the last redraw while the CSS box moves on, and
  // every screen-to-board conversion drifts by the difference.
  const [resizeTick, setResizeTick] = useState(0);

  // Observe the canvas element itself, not the window: a sidebar opening or
  // closing resizes this box without ever firing a window resize event.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const observer = new ResizeObserver(() => setResizeTick((tick) => tick + 1));
    observer.observe(canvas);
    return () => observer.disconnect();
  }, []);

  // Redraw whenever the board changes, the viewport moves, or the element's
  // own box is resized. `version` is the signal for the board: BoardImage
  // mutates in place, so React cannot see it change on its own.
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

    // TS's DOM lib wants Uint8ClampedArray<ArrayBuffer>; BoardImage exposes the
    // wider Uint8ClampedArray<ArrayBufferLike>. It is always backed by a plain
    // ArrayBuffer at runtime (board-image.ts allocates it with `new
    // Uint8ClampedArray(length)`), so this is a type-only cast, not a copy.
    const source = new ImageData(
      image.rgbaBuffer as Uint8ClampedArray<ArrayBuffer>,
      image.width,
      image.height,
    );
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
  }, [image, version, viewport, resizeTick]);

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
        const point = pointOf(event);
        pointers.current.set(event.pointerId, point);

        if (pointers.current.size === 1) {
          drag.current = { ...point, travelled: 0 };
        } else if (pointers.current.size === 2) {
          // A second finger joined a drag already in progress: stop panning
          // — zoomAt and panBy must never both apply to the same move — and
          // start the pinch from the two points as they are right now.
          wasMultiTouch.current = true;
          drag.current = null;
          const [a, b] = Array.from(pointers.current.values());
          pinch.current = { distance: Math.hypot(a.x - b.x, a.y - b.y) };
        }
      }}
      onPointerMove={(event) => {
        const point = pointOf(event);
        onHover(pixelAt(viewport, screen(), point, image), viewport.scale);

        if (!pointers.current.has(event.pointerId)) return;
        pointers.current.set(event.pointerId, point);

        if (pointers.current.size >= 2) {
          const [a, b] = Array.from(pointers.current.values());
          const distance = Math.hypot(a.x - b.x, a.y - b.y);
          const midpoint = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
          if (pinch.current) {
            const factor = distance / pinch.current.distance;
            setViewport((v) => clampToBoard(zoomAt(v, screen(), midpoint, factor, ZOOM_LIMITS), image));
          }
          pinch.current = { distance };
          return;
        }

        if (!drag.current) return;

        const dx = point.x - drag.current.x;
        const dy = point.y - drag.current.y;
        drag.current.travelled += Math.abs(dx) + Math.abs(dy);
        drag.current.x = point.x;
        drag.current.y = point.y;

        setViewport((v) => clampToBoard(panBy(v, -dx / v.scale, -dy / v.scale), image));
      }}
      onPointerUp={(event) => {
        const point = pointOf(event);
        // Whether THIS gesture ever involved a second pointer, decided before
        // this pointer leaves the map — a pinch must never paint, even when
        // it ends with only one finger still down.
        const singlePointerTap = drag.current !== null && !wasMultiTouch.current && isTap(drag.current.travelled);
        pointers.current.delete(event.pointerId);

        if (pointers.current.size > 0) {
          // One finger of a pinch lifted; the other is still down. Stop the
          // pinch rather than guess at resuming a pan from a stale anchor.
          pinch.current = null;
          return;
        }

        drag.current = null;
        pinch.current = null;
        wasMultiTouch.current = false;
        if (!singlePointerTap) return;

        const pixel = pixelAt(viewport, screen(), point, image);
        if (pixel) onPaint(pixel.x, pixel.y);
      }}
      onPointerLeave={(event) => {
        pointers.current.delete(event.pointerId);
        if (pointers.current.size === 0) {
          drag.current = null;
          pinch.current = null;
          wasMultiTouch.current = false;
        } else {
          pinch.current = null;
        }
        onHover(null, viewport.scale);
      }}
      onWheel={(event) => {
        const factor = event.deltaY < 0 ? 1.2 : 1 / 1.2;
        setViewport((v) => clampToBoard(zoomAt(v, screen(), pointOf(event), factor, ZOOM_LIMITS), image));
      }}
    />
  );
}

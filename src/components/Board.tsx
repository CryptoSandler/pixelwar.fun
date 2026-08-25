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

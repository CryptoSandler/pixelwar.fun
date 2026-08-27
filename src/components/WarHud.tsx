"use client";

/**
 * The instrument readout: where the pointer is, and how far in.
 *
 * The countdown used to live here too and does not any more — it moved to
 * `WarClock` in the rail, because a war's ending is the event and this strip
 * is telemetry. What is left is the two numbers that answer "where am I on
 * this board", which is exactly what a readout is for.
 *
 * Both are monospaced and tabular (DESIGN.md §3): coordinates that change on
 * every pointer move would otherwise shift this strip's width continuously
 * while somebody is trying to aim.
 */
export function WarHud({
  hovered,
  scale,
}: {
  hovered: { x: number; y: number } | null;
  scale: number;
}) {
  return (
    <div className="readout bevel-in flex shrink-0 items-center justify-between px-3 py-1.5">
      <span className="numeric text-[12px]">
        {hovered ? `${hovered.x}, ${hovered.y}` : "--, --"}
      </span>
      <span className="numeric text-[12px]">{scale.toFixed(1)}x</span>
    </div>
  );
}

"use client";

import { useCallback, useMemo, useRef } from "react";
import { CHIP_OUTLINE, CHROME_SURFACES } from "../lib/wars/chrome";
import { colourForSlot } from "../lib/wars/palette";

/**
 * The twenty-four colours of a war, and which of them are still open.
 *
 * Every swatch is a token chip, so every swatch carries an outline from
 * `CHIP_OUTLINE` keyed by the surface it is drawn on (DESIGN.md I2). Without
 * it the white token vanishes on a light panel and the black one on a dark
 * header — a failure no test of the code can catch, because nothing about
 * the code is wrong when it happens.
 *
 * Selection is shown on the CONTROL — a brass border and an inverted bevel —
 * and never on the chip, which keeps its own outline throughout. That split
 * is what keeps I5 true: brass says "this is the one you picked", an action
 * you took, while the chip goes on saying only what colour it is. A brass
 * chip outline would make the accent part of a token's appearance.
 */

const COLUMNS = 8;

export type ColourPickerProps = {
  /** How many slots this war offers, `wars.max_tokens`. Never more than the palette. */
  total: number;
  /** Slots with no live claim on them, from `GET /api/colours`. */
  free: number[];
  selected: number | null;
  onSelect: (slot: number) => void;
  /** The chrome surface the swatches are drawn on, which sets the chip outline. */
  surface?: keyof typeof CHROME_SURFACES;
};

export function ColourPicker({
  total,
  free,
  selected,
  onSelect,
  surface = "control",
}: ColourPickerProps) {
  const outline = CHIP_OUTLINE[surface];
  const freeSet = useMemo(() => new Set(free), [free]);
  const slots = Array.from({ length: total }, (_, index) => index + 1);
  const container = useRef<HTMLDivElement>(null);

  // The paint bar is a single tab stop with arrow-key traversal (DESIGN.md
  // §9), and so is this: twenty-four tab stops between the address field and
  // the button would make the keyboard path to paying absurd. The focused
  // swatch is whichever one is selected, or the first one that can be.
  const focusable = selected !== null && freeSet.has(selected) ? selected : (free[0] ?? null);

  const move = useCallback(
    (from: number, step: number) => {
      let next = from + step;
      // Taken colours are skipped rather than focused-and-refused: arrowing
      // onto something that cannot be chosen teaches nothing.
      while (next >= 1 && next <= total && !freeSet.has(next)) next += step;
      if (next < 1 || next > total) return;
      onSelect(next);
      container.current?.querySelector<HTMLButtonElement>(`[data-slot="${next}"]`)?.focus();
    },
    [freeSet, onSelect, total],
  );

  function onKeyDown(event: React.KeyboardEvent<HTMLDivElement>) {
    const from = focusable;
    if (from === null) return;
    const step =
      event.key === "ArrowRight" ? 1
      : event.key === "ArrowLeft" ? -1
      : event.key === "ArrowDown" ? COLUMNS
      : event.key === "ArrowUp" ? -COLUMNS
      : 0;
    if (step === 0) return;
    event.preventDefault();
    move(from, step);
  }

  return (
    <div
      ref={container}
      role="radiogroup"
      aria-label="Colour"
      onKeyDown={onKeyDown}
      className="grid gap-[3px]"
      style={{ gridTemplateColumns: `repeat(${COLUMNS}, minmax(0, 1fr))` }}
    >
      {slots.map((slot) => {
        const isFree = freeSet.has(slot);
        const isSelected = slot === selected;
        // `.swatch` carries the bevel, and turns its border brass when
        // aria-checked is true — the accent on the control, never on the chip
        // inside it. See the note at the top of this file.
        return (
          <button
            key={slot}
            type="button"
            role="radio"
            data-slot={slot}
            aria-checked={isSelected}
            aria-label={isFree ? `Colour ${slot}` : `Colour ${slot}, taken`}
            title={isFree ? undefined : "That colour is taken"}
            disabled={!isFree}
            tabIndex={slot === focusable ? 0 : -1}
            onClick={() => onSelect(slot)}
            className="swatch flex flex-col items-center gap-[3px] p-[3px] disabled:cursor-not-allowed"
          >
            <span
              aria-hidden
              className="block h-6 w-full"
              style={{
                background: colourForSlot(slot),
                outline: `1px solid ${outline}`,
                outlineOffset: "-1px",
                opacity: isFree ? 1 : 0.3,
              }}
            />
            <span
              className="font-mono text-[11px] leading-none tabular-nums"
              style={{ textDecoration: isFree ? undefined : "line-through", opacity: isFree ? 1 : 0.5 }}
            >
              {slot}
            </span>
          </button>
        );
      })}
    </div>
  );
}

"use client";

import { CHIP_OUTLINE } from "../lib/wars/chrome";
import { PALETTE_SIZE, colourForSlot } from "../lib/wars/palette";

/**
 * The colour this painter is about to paint in — all of them, always.
 *
 * A DIFFERENT COMPONENT FROM `ColourPicker`, on purpose, and the difference
 * is the whole product change. `ColourPicker` is the buying screen: it shows
 * which SLOTS in a war are still open, strikes through the taken ones, and
 * the thing you pick there becomes your token's flag. This one shows the
 * palette as a painting tool, where nothing is ever taken and nothing is ever
 * struck through, because a colour is no longer something anybody can own.
 *
 * Merging the two would mean one component with a "can things be unavailable
 * here" flag, which is two screens wearing one name — and the flag would be
 * the only thing standing between the paint palette and re-growing the
 * exclusivity this change removed.
 *
 * Chips keep their outline (DESIGN.md I2), keyed by the surface they sit on:
 * without it #FFFFFF vanishes on a light panel and #000000 on a dark one, and
 * no test of the code can catch that because nothing about the code is wrong
 * when it happens. Selection is shown on the CONTROL — a brass border — never
 * on the chip, so the accent never becomes part of a colour's appearance.
 */
export function PaintPalette({
  selected,
  onSelect,
  disabled = false,
}: {
  selected: number;
  onSelect: (slot: number) => void;
  disabled?: boolean;
}) {
  return (
    <fieldset className="border-0 p-0 m-0" disabled={disabled}>
      <legend className="sr-only">Paint colour</legend>
      <ul className="grid grid-cols-8 gap-1" role="radiogroup" aria-label="Paint colour">
        {Array.from({ length: PALETTE_SIZE }, (_, i) => i + 1).map((slot) => {
          const colour = colourForSlot(slot);
          const isSelected = slot === selected;
          return (
            <li key={slot}>
              <button
                type="button"
                role="radio"
                aria-checked={isSelected}
                aria-label={`Colour ${slot}`}
                onClick={() => onSelect(slot)}
                className="block h-7 w-7 p-[3px]"
                style={{
                  background: CHROME_CONTROL,
                  border: isSelected ? "2px solid var(--chrome-accent)" : "2px solid transparent",
                }}
              >
                <span
                  aria-hidden
                  className="block h-full w-full"
                  style={{
                    background: colour,
                    outline: `1px solid ${CHIP_OUTLINE.panel}`,
                    outlineOffset: "-1px",
                  }}
                />
              </button>
            </li>
          );
        })}
      </ul>
    </fieldset>
  );
}

/**
 * Read from the CSS custom property the layout sets from `chrome.ts`, so this
 * file carries no second copy of a measured surface colour to drift from it.
 */
const CHROME_CONTROL = "var(--chrome-control)";

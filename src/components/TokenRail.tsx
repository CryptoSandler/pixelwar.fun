"use client";

import { colourForSlot } from "../lib/wars/palette";

export type RailToken = {
  id: string;
  ticker: string;
  name: string;
  colourSlot: number;
  owned: number;
};

export function TokenRail({
  tokens,
  selectedId,
  onSelect,
}: {
  tokens: RailToken[];
  selectedId: string | null;
  onSelect: (id: string) => void;
}) {
  return (
    <ul className="flex gap-2 overflow-x-auto md:flex-col">
      {tokens.map((token, index) => {
        // /api/leaderboard is untrusted input, same as the canvas bytes
        // BoardImage renders — and BoardImage was deliberately hardened to
        // degrade a bad slot to unpainted rather than throw. colourForSlot
        // still throws RangeError on an out-of-range slot, which would take
        // down this whole page's render for one bad token. Same input, same
        // policy: skip the token we cannot render rather than crash.
        let colour: string;
        try {
          colour = colourForSlot(token.colourSlot);
        } catch {
          return null;
        }

        return (
          <li key={token.id}>
            <button
              type="button"
              onClick={() => onSelect(token.id)}
              aria-pressed={token.id === selectedId}
              className="flex items-center gap-2 rounded px-2 py-1"
            >
              <span aria-hidden className="h-4 w-4 rounded-sm" style={{ background: colour }} />
              <span className="font-mono">{token.ticker}</span>
              <span className="tabular-nums opacity-70">{token.owned}</span>
              {index < 9 ? <kbd className="opacity-40">{index + 1}</kbd> : null}
            </button>
          </li>
        );
      })}
    </ul>
  );
}

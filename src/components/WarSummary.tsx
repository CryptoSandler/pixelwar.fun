"use client";

import type { RailToken } from "./TokenRail";

/**
 * The war in four numbers, above the scoreboard.
 *
 * WHAT IT REPLACES: prose. The sidebar used to explain the war in sentences
 * and show counts only inside the rows — so "how big is this" and "who is
 * winning" were answered by reading every row and adding up. A war is a
 * contest and a contest has a scoreline.
 *
 * PROSE SURVIVES ONLY AT ABSOLUTE ZERO. A board with no tokens, no painters
 * and no pixels has nothing to count, and three zeroes say less than one
 * sentence — that is the one case where a number is worse than a word. The
 * moment any of them moves, the numbers take over and the sentence goes.
 */
export function WarSummary({
  tokens,
  boardPixels,
}: {
  tokens: RailToken[];
  boardPixels: number;
}) {
  const painters = tokens.reduce((total, token) => total + token.painters, 0);
  const painted = tokens.reduce((total, token) => total + token.owned, 0);

  // Absolute zero: nothing has happened at all. Not "no leader yet" — no
  // tokens, no painters, no paint.
  if (tokens.length === 0 && painters === 0 && painted === 0) {
    return (
      <p className="muted text-[13px]">
        No tokens have entered yet. The first one to join takes a flag and the board opens.
      </p>
    );
  }

  const share = boardPixels > 0 ? (painted / boardPixels) * 100 : 0;

  /*
   * THREE FIGURES, AND THE MISSING FOURTH IS THE POINT.
   *
   * This carried a "Leader" figure, forty pixels below the `Leading` readout
   * that is the headline of the whole sidebar — so the screen answered "who is
   * winning" twice, in two type sizes, and said "nobody holds a pixel yet"
   * twice on an empty board. WarView's own comment four lines further down
   * already named that mistake in this exact sidebar: "One list, not two...
   * the sidebar asking the same question twice."
   *
   * So the headline keeps the leader, and this keeps the three questions the
   * headline does not answer: how many communities are in, how many people
   * are painting, and how much of the board is claimed.
   */
  return (
    <dl className="grid grid-cols-3 gap-x-3 gap-y-1">
      <Figure label="Tokens" value={String(tokens.length)} />
      <Figure label="Painters" value={String(painters)} />
      <Figure
        label="Pixels"
        value={String(painted)}
        // The board's share, because 4,000 means nothing without the 40,000
        // it is out of.
        note={painted > 0 ? `${share < 0.1 ? "<0.1" : share.toFixed(1)}% of the board` : undefined}
      />
    </dl>
  );
}

function Figure({ label, value, note }: { label: string; value: string; note?: string }) {
  return (
    <div className="flex flex-col">
      <dt className="section-label muted">{label}</dt>
      <dd className="numeric text-[15px]">{value}</dd>
      {note ? <dd className="muted text-[11px]">{note}</dd> : null}
    </div>
  );
}

import { diffMaxChanges } from "../config";
import { query, queryOne } from "../db";
import type { War } from "../wars/lifecycle";
import type { CanvasLayer } from "./state";

export type DiffResult =
  | { resync: false; seq: number; changes: [number, number][] }
  | { resync: true; seq: number };

/**
 * Everything that happened after `since`, or an instruction to start over.
 *
 * Beyond a few thousand changes, JSON pairs cost more than the whole board
 * does as bytes, so a client that has been away is told to refetch instead.
 * That is cheaper for both sides and it is also the escape hatch for a client
 * whose sequence we no longer recognise.
 *
 * `layer` mirrors `canvasBytes`: a client watching the painted board asks for
 * colours, a client watching the territory toggle asks for owners, and
 * neither pays for the other. See `state.ts` on why this is two layers rather
 * than two bytes per pixel.
 */
export async function changesSince(
  war: War,
  since: number,
  max: number = diffMaxChanges(),
  layer: CanvasLayer = "colour",
): Promise<DiffResult> {
  const head = await queryOne<{ last_seq: string }>(`SELECT last_seq FROM wars WHERE id = $1`, [
    war.id,
  ]);
  const seq = Number(head?.last_seq ?? 0);

  // A client claiming a sequence we have not reached is not an error worth an
  // error: it has nothing to learn, and telling it so costs one comparison.
  if (since >= seq) return { resync: false, seq, changes: [] };
  if (seq - since > max) return { resync: true, seq };

  if (layer === "token") {
    const rows = await query<{ idx: number; slot: number | null }>(
      `SELECT e.idx, t.colour_slot AS slot
         FROM pixel_events e
         LEFT JOIN war_tokens t ON t.id = e.war_token_id
        WHERE e.war_id = $1 AND e.seq > $2 AND e.seq <= $3
        ORDER BY e.seq ASC`,
      [war.id, since, seq],
    );

    // An event with no attribution predates migration 007, which added the
    // column — see that migration on why those were deliberately not
    // backfilled with a guess. There is no honest byte to send for one, and
    // sending 0 would read as "unpainted", quietly erasing a pixel from the
    // territory view. Resync instead: the full token layer is built from
    // `pixels`, which always knows the current owner.
    if (rows.some((row) => row.slot === null)) return { resync: true, seq };

    return { resync: false, seq, changes: rows.map((row) => [row.idx, row.slot as number]) };
  }

  const rows = await query<{ idx: number; colour_slot: number }>(
    `SELECT idx, colour_slot FROM pixel_events
      WHERE war_id = $1 AND seq > $2 AND seq <= $3
      ORDER BY seq ASC`,
    [war.id, since, seq],
  );

  return { resync: false, seq, changes: rows.map((row) => [row.idx, row.colour_slot]) };
}

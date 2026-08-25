import { diffMaxChanges } from "../config";
import { query, queryOne } from "../db";
import type { War } from "../wars/lifecycle";

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
 */
export async function changesSince(
  war: War,
  since: number,
  max: number = diffMaxChanges(),
): Promise<DiffResult> {
  const head = await queryOne<{ last_seq: string }>(`SELECT last_seq FROM wars WHERE id = $1`, [
    war.id,
  ]);
  const seq = Number(head?.last_seq ?? 0);

  // A client claiming a sequence we have not reached is not an error worth an
  // error: it has nothing to learn, and telling it so costs one comparison.
  if (since >= seq) return { resync: false, seq, changes: [] };
  if (seq - since > max) return { resync: true, seq };

  const rows = await query<{ idx: number; colour_slot: number }>(
    `SELECT idx, colour_slot FROM pixel_events
      WHERE war_id = $1 AND seq > $2 AND seq <= $3
      ORDER BY seq ASC`,
    [war.id, since, seq],
  );

  return { resync: false, seq, changes: rows.map((row) => [row.idx, row.colour_slot]) };
}

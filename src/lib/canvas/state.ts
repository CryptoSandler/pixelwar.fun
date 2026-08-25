import { query, queryOne } from "../db";
import type { War } from "../wars/lifecycle";

/**
 * The whole board, one byte per pixel, value = palette slot, 0 = unpainted.
 *
 * The sequence number is read BEFORE the pixels, and the order matters. Read
 * it after, and a paint landing in between produces a board that is missing a
 * pixel the client will never be told about again — a permanent hole. Read it
 * before, and the worst case is that the board already contains a change the
 * client also receives in its first diff, which writes the same value twice.
 *
 * Over-deliver, never under-deliver: this ordering is deliberate, and it is
 * safe only because re-delivering a change is a no-op — a client that applies
 * the same (idx, slot) pair twice ends up exactly where it started. The other
 * ordering has no safe failure mode at all: a pixel missing from the board
 * but already below the reported sequence is never requested again, and is
 * gone from that client's screen for the rest of the war.
 */
export async function canvasBytes(war: War): Promise<{ seq: number; bytes: Uint8Array }> {
  const head = await queryOne<{ last_seq: string }>(`SELECT last_seq FROM wars WHERE id = $1`, [
    war.id,
  ]);
  const seq = Number(head?.last_seq ?? 0);

  const rows = await query<{ idx: number; colour_slot: number }>(
    `SELECT p.idx, t.colour_slot
       FROM pixels p
       JOIN war_tokens t ON t.id = p.war_token_id
      WHERE p.war_id = $1`,
    [war.id],
  );

  const bytes = new Uint8Array(war.width * war.height);
  for (const row of rows) bytes[row.idx] = row.colour_slot;

  return { seq, bytes };
}

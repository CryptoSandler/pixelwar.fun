import { query, queryOne } from "../db";
import type { War } from "../wars/lifecycle";

/**
 * The board as bytes, in one of two layers.
 *
 * TWO LAYERS RATHER THAN TWO BYTES PER PIXEL, and the reason is the wire.
 * This response is 40,000 bytes for a 200x200 board. Since a pixel now has
 * both a painted colour and an attributed token, one obvious encoding is two
 * bytes per pixel — which doubles this to 80,000 bytes for EVERY visitor,
 * including the overwhelming majority who never open the territory toggle.
 * Serving the second layer only when it is asked for keeps the default view
 * at exactly the size it is today and charges the extra 40,000 bytes to the
 * one person who wanted it. `/api/diff` splits the same way.
 *
 *   "colour"  what was painted. `pixels.colour_slot`, chosen freely by the
 *             painter, 0 = unpainted. This is the default view and it no
 *             longer needs a JOIN at all — the colour used to be reachable
 *             only through the painting token, and now it is on the row.
 *
 *   "token"   who owns it. `war_tokens.colour_slot`, which is the token's own
 *             slot in this war and doubles as its flag colour on the
 *             scoreboard. Not the colour on the board any more, and that is
 *             the entire point of the toggle: it answers a question the
 *             painted board deliberately stopped answering.
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
export type CanvasLayer = "colour" | "token";

export async function canvasBytes(
  war: War,
  layer: CanvasLayer = "colour",
): Promise<{ seq: number; bytes: Uint8Array }> {
  const head = await queryOne<{ last_seq: string }>(`SELECT last_seq FROM wars WHERE id = $1`, [
    war.id,
  ]);
  const seq = Number(head?.last_seq ?? 0);

  const rows =
    layer === "token"
      ? await query<{ idx: number; slot: number }>(
          `SELECT p.idx, t.colour_slot AS slot
             FROM pixels p
             JOIN war_tokens t ON t.id = p.war_token_id
            WHERE p.war_id = $1`,
          [war.id],
        )
      : await query<{ idx: number; slot: number }>(
          `SELECT idx, colour_slot AS slot FROM pixels WHERE war_id = $1`,
          [war.id],
        );

  const bytes = new Uint8Array(war.width * war.height);
  for (const row of rows) bytes[row.idx] = row.slot;

  return { seq, bytes };
}

-- The 24-token ceiling stops being the palette's opinion and becomes an
-- admission policy the operator sets per war.
--
-- WHY IT WAS 24. Under the old model a token WAS a palette slot, so a war
-- could not seat more tokens than there were colours — the ceiling was not a
-- product decision at all, it was arithmetic. Migration 007 removed the
-- premise: painters choose colours now, and a token's slot is only its flag.
-- The number 24 survived as a CHECK constraint that no longer had a reason,
-- which is the worst kind of limit — one nobody chose and nobody can explain.
--
-- WHAT REPLACES IT. 255, and that IS arithmetic rather than a preference: the
-- territory layer sends one byte per pixel holding the owning token's slot
-- (see canvas/state.ts), and 0 is reserved for unpainted. A war may not seat
-- more tokens than that byte can name. Anything under it is the operator's
-- call, which is what "admission cap" means.
--
-- WHAT THIS COSTS, stated plainly because it is a visible consequence and not
-- a detail: past 24 tokens, FLAG COLOURS REPEAT. The palette has 24 entries
-- and slot 25 wraps back onto the first (see flagColourForSlot). Two tokens
-- in the same war can therefore carry the same flag on the scoreboard and in
-- the territory view, and are told apart there by ticker rather than by
-- colour. That is a real limitation of a 24-colour palette, not a bug; a war
-- that wants every token visually distinct should keep its cap at 24, which
-- is still the default.
ALTER TABLE wars DROP CONSTRAINT wars_max_tokens_check;
ALTER TABLE wars ADD CONSTRAINT wars_max_tokens_check CHECK (max_tokens BETWEEN 1 AND 255);

-- The token's own slot in its war: its identity for the territory layer, and
-- the index its flag colour is derived from. Same ceiling, same reason.
ALTER TABLE war_tokens DROP CONSTRAINT war_tokens_colour_slot_check;
ALTER TABLE war_tokens ADD CONSTRAINT war_tokens_colour_slot_check
  CHECK (colour_slot BETWEEN 1 AND 255);

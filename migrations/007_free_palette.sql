-- Free palette: the colour a pixel is painted stops being the token that
-- painted it.
--
-- WHAT THIS UNDOES. Until now the model was "a canvas byte is a palette slot,
-- a palette slot is a token" — so the board needed no second structure to say
-- who owned what, and a token's colour was exclusive by construction. That is
-- a product decision that has been reversed: anybody may paint in any of the
-- 24 colours, and attribution travels with the painter's token instead of
-- with the colour.
--
-- WHAT IS ALREADY HERE, and is why this migration is small. `pixels` has
-- carried `war_token_id` since 001 — attribution was never derived, it was
-- always stored. What was derived is the COLOUR, by joining a pixel to its
-- token's `colour_slot` (see canvasBytes). So the change is not a new model;
-- it is one column that stops a JOIN from being the only way to know what
-- colour a pixel is.
--
-- TWO COLUMNS NAMED colour_slot, MEANING DIFFERENT THINGS, deliberately:
--
--   pixels.colour_slot        the colour this pixel was PAINTED, 1..24, freely
--   pixel_events.colour_slot  the same thing, already here since 001
--   war_tokens.colour_slot    the token's own slot in this war, and its flag
--                             colour for the scoreboard and territory view
--
-- The first two agree with each other and always did. The third used to be
-- the same number as the first for every pixel a token painted; from now on
-- it is unrelated to it. Nothing renames, because in the pixel tables
-- `colour_slot` already meant "painted colour" and still does.
ALTER TABLE pixels ADD COLUMN colour_slot SMALLINT;

-- Backfill is exact, not a guess. Every existing pixel was painted in its
-- token's colour, because that was the only colour it could have been painted
-- in — the old model had no way to express anything else. So this recovers
-- the painted colour rather than inventing one.
UPDATE pixels p
   SET colour_slot = t.colour_slot
  FROM war_tokens t
 WHERE t.id = p.war_token_id
   AND p.colour_slot IS NULL;

ALTER TABLE pixels ALTER COLUMN colour_slot SET NOT NULL;

-- The territory view needs to answer "which token owns this pixel" for a
-- whole board, and a diff of that view needs the same per change. `pixels`
-- answers it for the current board; `pixel_events` is what a client already
-- holding a board applies on top, and it had no attribution in it.
--
-- NULLABLE, and it stays nullable forever. An event older than this migration
-- cannot be attributed: `pixels` only remembers the token that painted a
-- pixel LAST, so for any pixel painted more than once the earlier events'
-- owners are simply not recorded anywhere. Backfilling those with the current
-- owner would be fabrication — it would claim a token painted a pixel it may
-- never have touched. A NULL here means "this event predates attribution",
-- and the territory diff treats it as a reason to resync rather than as an
-- owner.
ALTER TABLE pixel_events ADD COLUMN war_token_id TEXT REFERENCES war_tokens (id);

-- The one case that CAN be recovered honestly: an event that is the very
-- event that produced the pixel's current state. There the current owner and
-- the event's owner are the same fact, not an assumption.
UPDATE pixel_events e
   SET war_token_id = p.war_token_id
  FROM pixels p
 WHERE p.war_id = e.war_id
   AND p.idx = e.idx
   AND p.seq = e.seq
   AND e.war_token_id IS NULL;

-- A board has a size, and the size has ends.
--
-- WHAT THIS DOES NOT ADD. `wars.width` and `wars.height` have existed since
-- migration 001, `INTEGER NOT NULL DEFAULT 200`, and every reader already
-- takes its size from them: `canvasBytes` allocates `war.width * war.height`,
-- `BoardImage` allocates from the pair, the scoreboard's share is computed
-- against `war.width * war.height`, and `revertRegion` derives a column with
-- `idx % width`. Per-war board size was never a constant in this codebase.
--
-- WHAT WAS ACTUALLY MISSING, AND IT WAS A HOLE RATHER THAN A FEATURE. Nothing
-- bounded either column. A war inserted with width 100000 was accepted by the
-- schema, and the first request for its board asks the server for a
-- ten-gigabyte Uint8Array. That has been true since 001; it was reachable only
-- by an operator, which is why it never fired.
--
-- WHY 100 AND 1000, and why they are a CHECK rather than a rule in
-- `docs/operations.md` like the token cap. The token cap is taste — it comes
-- from the length of a colour list and an operator can reasonably want it
-- higher. These are not taste. Below 100 the board is too small to draw
-- anything a community would recognise as its own, and above 1000 a single
-- `/api/canvas` response is a megabyte per spectator per poll, which is a
-- denial of service the operator performs on themselves. A number whose
-- ceiling is arithmetic about bytes belongs in the schema; a number whose
-- ceiling is a product opinion does not.
ALTER TABLE wars
  ADD CONSTRAINT wars_board_size_bounds
  CHECK (width BETWEEN 100 AND 1000 AND height BETWEEN 100 AND 1000);

COMMENT ON CONSTRAINT wars_board_size_bounds ON wars IS
  'A board is between 100 and 1000 a side. The floor is legibility; the ceiling is that /api/canvas serves one byte per pixel, so 1000x1000 is a megabyte per spectator per poll.';

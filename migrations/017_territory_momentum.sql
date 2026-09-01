-- Which way the board is moving, measurable at all.
--
-- THE PROBLEM THIS FIXES, AND IT WAS MEASURED RATHER THAN SUSPECTED. The
-- first attempt derived momentum from `pixel_events` alone, comparing each
-- event with the previous one on the same cell inside a ten-minute window.
-- Postgres applies WHERE before window functions, so `lag()` only ever saw
-- rows already inside the window — and a raid, by definition, overpaints
-- cells somebody claimed hours ago. Against a seeded board where 216 pixels
-- genuinely changed hands, that query reported ZERO losses for anybody, and
-- credited a token for retouching its own old art.
--
-- Doing it exactly from the event history needs indexes on `(war_id,
-- painted_at)` and `(war_id, idx, seq)` — two more b-trees maintained inside
-- the paint transaction, which `docs/operations.md` measures a ~40 paints per
-- second ceiling for and which is serialised on a row lock. Momentum is a
-- display signal. It does not get to make the write path slower.
--
-- So it is read from a periodic snapshot of a number the paint path ALREADY
-- maintains transactionally: `token_pixel_counts.owned`. Momentum is
-- `owned` now minus `owned` at the snapshot, which is exact by construction
-- and costs the writer nothing, because the writer was already writing it.

CREATE TABLE token_pixel_snapshots (
  war_id       TEXT        NOT NULL REFERENCES wars (id),
  war_token_id TEXT        NOT NULL REFERENCES war_tokens (id),
  taken_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  owned        INTEGER     NOT NULL,
  -- Carried alongside `owned` so a reader can subtract it; see the column
  -- comment on `token_pixel_counts.removed_by_moderation` below.
  removed_by_moderation INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (war_id, war_token_id, taken_at)
);

-- The index the read actually uses: "the newest snapshot at or before T, for
-- this token". The primary key above cannot serve it — its leading columns
-- are right but a reader wants the rows in DESCENDING time order, and it also
-- wants to sweep a whole war by age when pruning.
CREATE INDEX token_pixel_snapshots_age
  ON token_pixel_snapshots (war_id, war_token_id, taken_at DESC);

COMMENT ON TABLE token_pixel_snapshots IS
  'Periodic copies of token_pixel_counts, so a reader can diff "now" against "ten minutes ago" without scanning pixel_events. Written lazily on the leaderboard read, at most once a minute per war; pruned by the reconcile sweep.';

-- Moderation is not somebody losing a fight.
--
-- `revertRegion` decrements `owned` when it clears vandalism, so a snapshot
-- diff would charge the token a loss for having its own graffiti removed —
-- and put a moderator's action on a public scoreboard, which is the one thing
-- the board signal work was careful never to do. Counting the removals
-- separately lets the reader add them back and report only what was taken by
-- another community.
--
-- A COUNTER RATHER THAN A LOG. This is a running total per token per war, not
-- a row per removal: the reader only ever needs the difference between two
-- points in time, and a log would be a second history of moderation actions
-- with no owner and no retention policy.
ALTER TABLE token_pixel_counts
  ADD COLUMN removed_by_moderation INTEGER NOT NULL DEFAULT 0;

COMMENT ON COLUMN token_pixel_counts.removed_by_moderation IS
  'Running total of this token''s pixels cleared by moderation in this war. Subtracted from a momentum diff so a revert never reads as ground lost to a rival. Never displayed on its own.';

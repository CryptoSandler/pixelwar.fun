-- recoverUnclaimedOrders (Task 11) needs a way to tell "never looked at"
-- from "looked at and there was nothing to find", or its own candidate
-- query keeps re-selecting the same oldest-expired rows forever: the
-- overwhelming majority of expired orders are ordinary abandoned
-- reservations whose reference the chain will never mention, and with no
-- progress marker they permanently crowd out the rare real unclaimed
-- payment once twenty of them exist that are older than it.
--
-- recovery_attempted_at is stamped by that pass for every order it examines,
-- whatever the outcome (settled, filed, or nothing found) — see recover.ts.
-- NULL means "never examined by a recovery pass", and sorts first, so a
-- fresh candidate always gets a turn before one already checked and found
-- wanting.
ALTER TABLE entry_orders ADD COLUMN recovery_attempted_at TIMESTAMPTZ;

-- Matches the candidate query's own WHERE clause exactly (status = 'expired'
-- plus the age bound below), so the ORDER BY it drives — least-recently-
-- attempted first, then most-recently-expired first — is served by an index
-- scan instead of a sort over the whole expired set.
CREATE INDEX entry_orders_recovery_candidates
  ON entry_orders (recovery_attempted_at, expires_at DESC)
  WHERE status = 'expired';

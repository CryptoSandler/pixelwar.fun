-- recoverUnclaimedOrders (Task 11) needs a way to tell "never looked at"
-- from "looked at and there was nothing to find", or its own candidate
-- query keeps re-selecting the same oldest-expired rows forever: the
-- overwhelming majority of expired orders are ordinary abandoned
-- reservations whose reference the chain will never mention, and with no
-- progress marker they permanently crowd out the rare real unclaimed
-- payment once twenty of them exist that are older than it.
--
-- recovery_attempted_at is stamped by that pass for every order it examines,
-- whatever the outcome (settled, filed, nothing found, or the search itself
-- throwing) — see recover.ts. NULL means "never examined by a recovery
-- pass", and sorts first, so a fresh candidate always gets a turn before one
-- already checked and found wanting.
--
-- The candidate query also bounds itself to orders that expired within the
-- last several days (see RECOVERY_MAX_AGE_DAYS in recover.ts) — an expired
-- order older than that stops being a candidate at all. Stated plainly, not
-- just in the constant's own favour: a real payment against an order that
-- old is never recovered *and never filed to unmatched_payments* — nothing
-- logs the moment it stopped being looked for. If that ever needs undoing by
-- hand, the row and its reference_pubkey are still right here in
-- entry_orders; the age bound does not delete either.
ALTER TABLE entry_orders ADD COLUMN recovery_attempted_at TIMESTAMPTZ;

-- Matches the candidate query's own WHERE clause (status = 'expired') and
-- its ORDER BY (recovery_attempted_at ASC NULLS FIRST, expires_at DESC)
-- exactly, including the NULLS FIRST an unqualified ASC column would not
-- give a btree index by default — so the planner can serve that ordering
-- from an index scan instead of a sort over the whole expired set.
CREATE INDEX entry_orders_recovery_candidates
  ON entry_orders (recovery_attempted_at ASC NULLS FIRST, expires_at DESC)
  WHERE status = 'expired';

-- Who asked for a challenge, so issuing them can be rate limited.
--
-- WHAT THE AUDIT FOUND. `POST /api/allegiance/nonce` carried a comment saying
-- it was "rate limited by the same identify() every write path uses".
-- `identify()` identifies; it does not limit. So the comment described a
-- defence that did not exist, which is the most expensive kind of comment to
-- be wrong: it stops the next reader from looking. Issuing a nonce writes a
-- row, and an unbounded caller was a table that grew for free.
--
-- WHY A COLUMN AND NOT THE CHECKOUT'S COUNTER. `verification_attempts` is
-- already shared between the entry checkout and the registration verifier,
-- and both of those spend the SAME scarce thing: calls against a
-- rate-limited RPC endpoint. Issuing a nonce spends no RPC at all — it is a
-- local INSERT — so putting it in that budget would mean a wallet asking to
-- sign could exhaust the allowance a payer needs to confirm money. Different
-- resource, different counter.
--
-- NULLABLE, because `identify()` can legitimately produce no address hash on
-- a deployment that allows untrusted client addresses in development. A NULL
-- here counts towards nothing and is never matched by the limit query, which
-- is the honest behaviour: an unidentifiable caller is not rate limited,
-- which is exactly why production refuses to run that way at all.
ALTER TABLE oath_nonces ADD COLUMN ip_hash TEXT;

-- The limit query asks "how many did this address take recently", so the
-- index leads with the address and carries the clock.
CREATE INDEX oath_nonces_ip ON oath_nonces (ip_hash, issued_at);

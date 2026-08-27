-- Nonces for the oath, so a signature cannot be replayed.
--
-- WHY THIS IS DIFFERENT FROM THE RECRUIT'S LOCK. Migration 009 says out loud
-- that a recruit's allegiance is a UX commitment and not a security boundary,
-- and that the soft cookie behind it is accepted rather than fought. The sworn
-- caste is the opposite: it is a claim about a wallet, made to the server,
-- that grants a visible mark other people can see. That IS security surface,
-- and it is built like it.
--
-- WHAT A SIGNED STRING WOULD HAVE GOTTEN WRONG. A fixed message — "I swear to
-- $TICKER" — is signed once and reusable forever: by anybody who ever sees it,
-- in any war, for as long as the wallet exists. Three things close that, and
-- all three live in the message the wallet actually signs:
--
--   the nonce   this row. Issued by the server, consumed on first use.
--   the war     so a signature from one war cannot swear in the next.
--   the expiry  so a leaked-but-unused signature stops working in minutes.
CREATE TABLE oath_nonces (
  nonce      TEXT PRIMARY KEY,
  war_id     TEXT        NOT NULL REFERENCES wars (id),
  -- The exact bytes the wallet is asked to sign. Stored rather than
  -- reconstructed at verification time: rebuilding it means two pieces of
  -- code agreeing on a format forever, and the day they disagree every oath
  -- fails with no way to tell a formatting drift from a forgery.
  message    TEXT        NOT NULL,
  issued_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ NOT NULL,
  -- Set the moment a nonce is spent. One signature, one use — and it is a
  -- timestamp rather than a boolean so an operator looking at a replay
  -- attempt can see when the original was consumed.
  used_at    TIMESTAMPTZ,
  CHECK (expires_at > issued_at)
);

-- Sweeping expired nonces is a housekeeping query, not a hot path, but it
-- runs against a table that grows with every visitor who opens the wallet
-- dialog and changes their mind.
CREATE INDEX oath_nonces_expiry ON oath_nonces (expires_at);

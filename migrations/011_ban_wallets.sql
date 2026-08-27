-- A wallet can be banned.
--
-- WHY THIS AND NOT A FEE. The question that produced it was how to make a
-- painter identity expensive enough that thirty of them cost something. The
-- answer already existed and was not being used: a sworn painter is bound to
-- a wallet (migration 009), and thirty sworn identities cost thirty token
-- purchases — more than any fee this product would charge, and the money goes
-- to the community rather than to us. See DESIGN.md §1a.
--
-- What was missing is that moderation could not name a wallet. `bans` has
-- accepted 'painter', 'ip' and 'subnet' since migration 001, and every one of
-- those is shed by clearing a cookie or changing network. The hard identity
-- existed and the only tool that needed it could not ask for it.
--
-- The CHECK is REPLACED rather than edited, because a CHECK cannot be
-- altered in place — it is dropped and recreated under the name Postgres
-- generated for it, `bans_key_type_check`, which was read from the live
-- catalog rather than guessed.
ALTER TABLE bans DROP CONSTRAINT bans_key_type_check;
ALTER TABLE bans ADD CONSTRAINT bans_key_type_check
  CHECK (key_type IN ('painter', 'ip', 'subnet', 'wallet'));

-- NOT touched, deliberately: `paint_cooldowns` has its own `key_type` with its
-- own CHECK over ('painter','ip','subnet'). It is a different table answering
-- a different question, and widening it here would be the kind of change that
-- looks tidy and quietly breaks rate limiting — a cooldown row keyed 'wallet'
-- would be written by nothing and read by nothing.

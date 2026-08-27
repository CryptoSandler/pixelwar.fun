-- Painting requires a registered wallet.
--
-- THE DECISION AND ITS PROVENANCE. An adversarial round recommended against
-- charging the painter, on the grounds that the painter is the product a
-- community buys with its admission. The owner decided otherwise, on two
-- grounds the round had weighed and one it had not: a small fee to the
-- creator is an established Solana pattern read as ritual rather than as a
-- toll, the audience being judged is a funded wallet rather than a newcomer,
-- and the fee is real anti-sybil — it turns "thirty identities is thirty
-- cleared cookies" into "thirty identities is thirty funded wallets".
-- DESIGN.md §1a carries the rewritten thesis and records that it supersedes
-- the previous one by the owner's decision.
--
-- TWO TABLES, BECAUSE THEY ARE TWO FACTS WITH DIFFERENT LIVES.
--
-- A REGISTRATION is permanent and belongs to a wallet. It is paid once, ever,
-- across every war. Nothing about it is per-war and nothing expires.
--
-- A LINK is which browser is currently acting as that wallet. It is
-- disposable by design: clearing a cookie produces a new painter key, and a
-- registered wallet must be able to claim a new one WITHOUT paying again.
-- Re-linking is proved by signature, using the oath machinery that already
-- exists — the fee buys the identity, not the session.
CREATE TABLE registrations (
  wallet          TEXT PRIMARY KEY,
  -- The transfer that paid for it. UNIQUE, so one payment registers one
  -- wallet: replaying a signature cannot mint a second registration, and the
  -- constraint is what enforces that rather than a check somebody remembers.
  signature       TEXT        NOT NULL UNIQUE,
  -- What actually arrived, in lamports. Stored rather than assumed: the fee
  -- is configuration and it will change, so a row has to say what THIS
  -- registration paid rather than what the current setting says it should
  -- have.
  lamports        BIGINT      NOT NULL,
  registered_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Which painter cookie is currently acting as which wallet.
--
-- The painter key is the PRIMARY KEY and the wallet is not unique: one wallet
-- may hold several links, because a person with a phone and a laptop is one
-- registration and two browsers. The reverse would force them to pay twice
-- for the second device, which is a toll on being the same person.
CREATE TABLE painter_wallets (
  painter_key TEXT PRIMARY KEY,
  wallet      TEXT        NOT NULL REFERENCES registrations (wallet),
  linked_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX painter_wallets_wallet ON painter_wallets (wallet);

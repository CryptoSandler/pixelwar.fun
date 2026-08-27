-- Allegiance: a painter fights for one token per war.
--
-- THE CULT MECHANIC, and the reason it is cheap. What makes a shared canvas
-- a war rather than a mural is that pixels belong to sides, and until now
-- nothing bound a painter to one: `POST /api/paint` took a `tokenId` in the
-- body of every single pixel, so one person could paint for all twenty-four
-- tokens in a minute. Every pixel was a free agent.
--
-- A UX COMMITMENT, NOT A SECURITY BOUNDARY, and the schema is built for the
-- first rather than pretending to the second. `painter_key` is a signed
-- cookie: clearing it produces a new painter with no allegiance. That is
-- accepted deliberately. Making the lock unforgeable means persistent
-- identity, which means accounts or wallets for everybody, which costs the
-- volume that IS the product (see DESIGN.md §1a). What enforces loyalty here
-- is the same thing that enforces it in the communities this is built for:
-- switching sides means abandoning your own record and starting at zero.
--
-- NOTHING IN COPY CALLS THIS PERMANENT. The lock is soft and a promise that
-- it is not would be the application lying about itself. The sanctioned
-- wording is "You fight for one token this war" — true whichever way a
-- painter behaves, and true for both castes.
CREATE TABLE war_painters (
  war_id       TEXT        NOT NULL REFERENCES wars (id),
  painter_key  TEXT        NOT NULL,
  war_token_id TEXT        NOT NULL REFERENCES war_tokens (id),

  -- The sworn caste. A wallet that proved it holds the token gets a visible
  -- mark, and its allegiance binds to something not discardable — so the
  -- people who care most get the hard version of the oath, and nobody pays
  -- for a lock the product does not need.
  --
  -- NULL for a recruit, which is most painters and is not a lesser state:
  -- the recruit army is the volume, and the volume is what a community buys
  -- with its admission.
  wallet       TEXT,
  sworn_at     TIMESTAMPTZ,

  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (war_id, painter_key),

  -- Either both or neither. A wallet with no timestamp is a row that cannot
  -- say when the holding was proven, and a timestamp with no wallet is a
  -- claim about nobody.
  CHECK ((wallet IS NULL) = (sworn_at IS NULL))
);

-- One wallet, one side, per war. This is the half of the mechanic that is
-- actually enforced: a recruit can start over by clearing a cookie, but a
-- wallet cannot be discarded and re-sworn to the other army in the same war.
CREATE UNIQUE INDEX war_painters_wallet ON war_painters (war_id, wallet)
  WHERE wallet IS NOT NULL;

-- The scoreboard asks "how many sworn does this token have" on every poll.
CREATE INDEX war_painters_token ON war_painters (war_id, war_token_id);

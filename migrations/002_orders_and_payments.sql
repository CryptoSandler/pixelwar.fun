-- Orders and payments.
--
-- Ported from bidoor (pending_bids, consumed_signatures, payments,
-- unmatched_payments, verification_attempts in ~/proyectos/outbid-tokens's
-- 001_initial.sql and 003_unmatched_sender.sql) with `bid_id` renamed to
-- `order_id` throughout. bidoor's unique-amount matching (`payment_micros`,
-- `pending_bids_payment_unique`) is dropped: a fixed entry price plus
-- signature + payer-pubkey + reference-pubkey binding (spec §5) replaces it,
-- so there is no fraction here to attribute a payment by.
--
-- The constraints below are not bookkeeping, they are the product's money
-- guarantees, each one closing a check-then-act race that application code
-- alone would lose to a concurrent request.

CREATE TABLE entry_orders (
  id               TEXT PRIMARY KEY,
  war_id           TEXT        NOT NULL REFERENCES wars (id),
  war_token_id     TEXT        NOT NULL REFERENCES war_tokens (id),
  amount_usd       INTEGER     NOT NULL CHECK (amount_usd > 0),  -- price snapshot
  -- Set when the order is created from a connected wallet. The transaction
  -- must have been funded by this key (spec §5).
  payer_pubkey     TEXT,
  -- Solana Pay reference: a unique, unguessable public key attached to the
  -- payment transaction as a read-only account, so a reconcile pass can find
  -- a payment whose payer never came back with the signature (spec §5). The
  -- server generates the keypair and keeps only the public half; the secret
  -- is discarded unread, and this migration only declares where it lives.
  reference_pubkey TEXT        NOT NULL UNIQUE,
  ip_hash          TEXT,
  status           TEXT        NOT NULL DEFAULT 'pending'
                     CHECK (status IN ('pending','paid','expired','failed')),
  failure_reason   TEXT,
  created_at       TIMESTAMPTZ NOT NULL,
  expires_at       TIMESTAMPTZ NOT NULL,
  paid_at          TIMESTAMPTZ
);
CREATE UNIQUE INDEX entry_orders_token_unique ON entry_orders (war_token_id);
CREATE INDEX entry_orders_status ON entry_orders (status, expires_at);

-- Every signature ever evaluated against the chain, whatever the verdict.
-- Claimed BEFORE the outcome is acted on, so a signature presented twice loses
-- the second time even if the first presentation did not match. This is what
-- stops an on-chain transfer being a bearer instrument anyone can spend.
CREATE TABLE consumed_signatures (
  signature   TEXT PRIMARY KEY,
  order_id    TEXT REFERENCES entry_orders (id),
  outcome     TEXT        NOT NULL,
  consumed_at TIMESTAMPTZ NOT NULL
);

-- One payment per signature, globally. This single constraint is what makes a
-- signature single-use across the whole system; everything else about replay
-- protection is commentary on it.
CREATE TABLE payments (
  id                TEXT PRIMARY KEY,
  signature         TEXT        NOT NULL UNIQUE,
  order_id          TEXT        NOT NULL REFERENCES entry_orders (id),
  -- u64 base units; TEXT because a JS number cannot hold one safely, the same
  -- reasoning that put wars.last_seq behind one BIGINT conversion point.
  amount_base_units TEXT        NOT NULL,
  payer             TEXT,
  verified_at       TIMESTAMPTZ NOT NULL
);

-- One order can only ever have one payment applied to it. The status check in
-- the confirm route is a check-then-act and loses to a concurrent request;
-- this does not.
CREATE UNIQUE INDEX payments_order_unique ON payments (order_id);

-- A confirmed transfer that reached our wallet but matched no order: a late
-- confirmation onto a war that is now full or ended, or a signature nobody
-- ever claimed. Recorded rather than discarded, because somebody's money
-- arrived and support needs to find it.
--
-- sender_fee_payer / sender_debited carry the sender the chain itself reports
-- (bidoor 003_unmatched_sender): the one fact that a person pasting an order
-- id into the recovery flow cannot forge, so reuniting a stray payment from
-- /admin does not mean trusting the claimant's word for who paid it.
CREATE TABLE unmatched_payments (
  id                  TEXT PRIMARY KEY,
  signature           TEXT        NOT NULL UNIQUE,
  order_id            TEXT        REFERENCES entry_orders (id),
  received_base_units TEXT        NOT NULL,
  expected_base_units TEXT        NOT NULL,
  reason              TEXT        NOT NULL,
  created_at          TIMESTAMPTZ NOT NULL,
  status              TEXT        NOT NULL DEFAULT 'open'
                        CHECK (status IN ('open', 'applied', 'discarded')),
  resolved_at         TIMESTAMPTZ,
  resolution_note     TEXT,
  applied_order_id    TEXT REFERENCES entry_orders (id),
  sender_fee_payer    TEXT,
  sender_debited      JSONB       NOT NULL DEFAULT '[]'::jsonb
);

CREATE INDEX unmatched_payments_status ON unmatched_payments (status, created_at);

-- Verification attempts, for rate limiting. Rows outside the window are swept:
-- this is a counter, not an audit log.
CREATE TABLE verification_attempts (
  id           TEXT PRIMARY KEY,
  order_id     TEXT        NOT NULL,
  ip_hash      TEXT,
  attempted_at TIMESTAMPTZ NOT NULL
);

CREATE INDEX verification_attempts_order ON verification_attempts (order_id, attempted_at);
CREATE INDEX verification_attempts_ip ON verification_attempts (ip_hash, attempted_at);

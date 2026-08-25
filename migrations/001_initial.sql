CREATE TABLE wars (
  id               TEXT PRIMARY KEY,
  slug             TEXT        NOT NULL UNIQUE,
  title            TEXT        NOT NULL,
  status           TEXT        NOT NULL DEFAULT 'draft'
                     CHECK (status IN ('draft','scheduled','live','ended','cancelled')),
  width            INTEGER     NOT NULL DEFAULT 200,
  height           INTEGER     NOT NULL DEFAULT 200,
  max_tokens       SMALLINT    NOT NULL DEFAULT 24 CHECK (max_tokens BETWEEN 1 AND 24),
  -- No DEFAULT, deliberately. An entry price a deploy can forget to set is an
  -- entry price somebody charges by accident.
  entry_price_usd  INTEGER     NOT NULL CHECK (entry_price_usd > 0),
  cooldown_seconds INTEGER     NOT NULL CHECK (cooldown_seconds BETWEEN 1 AND 3600),
  starts_at        TIMESTAMPTZ NOT NULL,
  ends_at          TIMESTAMPTZ NOT NULL,
  -- Monotonic and gapless. Allocated inside the paint transaction, never by a
  -- sequence: BIGSERIAL hands out values before commit, so a client polling
  -- ?since= could step over a row that committed late and lose it for good.
  last_seq         BIGINT      NOT NULL DEFAULT 0,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  ended_at         TIMESTAMPTZ,
  CHECK (ends_at > starts_at)
);

CREATE INDEX wars_status ON wars (status, starts_at);

CREATE TABLE war_tokens (
  id                  TEXT PRIMARY KEY,
  war_id              TEXT        NOT NULL REFERENCES wars (id),
  chain_id            TEXT        NOT NULL,
  contract            TEXT        NOT NULL,
  contract_key        TEXT        NOT NULL,
  colour_slot         SMALLINT    NOT NULL CHECK (colour_slot BETWEEN 1 AND 24),
  status              TEXT        NOT NULL DEFAULT 'reserved'
                        CHECK (status IN ('reserved','active','removed','released')),
  name                TEXT        NOT NULL,
  ticker              TEXT        NOT NULL,
  logo_url            TEXT,
  links               JSONB       NOT NULL DEFAULT '{}'::jsonb,
  metadata_fetched_at TIMESTAMPTZ NOT NULL,
  reserved_at         TIMESTAMPTZ NOT NULL,
  joined_at           TIMESTAMPTZ,
  released_at         TIMESTAMPTZ,
  released_reason     TEXT
);

-- A colour frees only when a reservation expires unpaid ('released'), never
-- when an operator pulls a token that already painted ('removed'): reissuing a
-- colour that has pixels on the board would hand one community's territory to
-- another.
CREATE UNIQUE INDEX war_tokens_colour_live
  ON war_tokens (war_id, colour_slot) WHERE status <> 'released';

CREATE UNIQUE INDEX war_tokens_contract_live
  ON war_tokens (war_id, contract_key) WHERE status <> 'released';

CREATE INDEX war_tokens_war ON war_tokens (war_id, status);

CREATE TABLE pixels (
  war_id       TEXT        NOT NULL REFERENCES wars (id),
  idx          INTEGER     NOT NULL,
  war_token_id TEXT        NOT NULL REFERENCES war_tokens (id),
  seq          BIGINT      NOT NULL,
  painted_at   TIMESTAMPTZ NOT NULL,
  painter_key  TEXT,
  ip_hash      TEXT,
  PRIMARY KEY (war_id, idx)
);

CREATE TABLE pixel_events (
  war_id      TEXT        NOT NULL REFERENCES wars (id),
  seq         BIGINT      NOT NULL,
  idx         INTEGER     NOT NULL,
  colour_slot SMALLINT    NOT NULL,
  painted_at  TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (war_id, seq)
);

CREATE TABLE token_pixel_counts (
  war_id       TEXT    NOT NULL REFERENCES wars (id),
  war_token_id TEXT    NOT NULL REFERENCES war_tokens (id),
  owned        INTEGER NOT NULL DEFAULT 0,
  placed       INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (war_id, war_token_id)
);

CREATE TABLE paint_cooldowns (
  war_id          TEXT        NOT NULL REFERENCES wars (id),
  key_type        TEXT        NOT NULL CHECK (key_type IN ('painter','ip','subnet')),
  key             TEXT        NOT NULL,
  last_painted_at TIMESTAMPTZ NOT NULL,
  -- Only meaningful for 'subnet', which is gated on a count per window rather
  -- than on an interval.
  window_start    TIMESTAMPTZ NOT NULL,
  window_count    INTEGER     NOT NULL DEFAULT 0,
  PRIMARY KEY (war_id, key_type, key)
);

CREATE TABLE bans (
  id         TEXT PRIMARY KEY,
  key_type   TEXT        NOT NULL CHECK (key_type IN ('painter','ip','subnet')),
  key        TEXT        NOT NULL,
  reason     TEXT,
  actor      TEXT        NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ
);

CREATE UNIQUE INDEX bans_key ON bans (key_type, key);

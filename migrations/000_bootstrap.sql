-- Nothing structural yet; 001 carries the schema. This file exists so the
-- runner has a migration to apply and the harness has something to assert on.
CREATE TABLE IF NOT EXISTS bootstrap_check (
  ok BOOLEAN NOT NULL DEFAULT TRUE
);

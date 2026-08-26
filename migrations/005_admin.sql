-- Admin access: revocable sessions and login throttling.
--
-- Adapted from outbid-tokens' 002_admin_hardening.sql, which answers three
-- findings about an admin token that behaved like a master secret: it sat in
-- the cookie in clear, could be guessed without limit or trace, and leaked its
-- length through an early-returning comparison. Two of those are schema, and
-- they are here.
--
-- Read by `src/lib/admin.ts` and nothing else. Its caller is
-- `POST /api/admin/session` (sign in) and, in the next task of this batch,
-- the `/admin/orphans` surface over `unmatched_payments`.
--
-- Note for a reader coming from the source project: its admin_audit_log is
-- deliberately NOT copied here. An append-only trail with nothing that reads
-- it is the shape this repo has already been bitten by (see AGENTS.md on
-- Batch B). It arrives with the surface that displays it, or not at all.

-- Sessions, so the cookie carries a revocable identifier instead of the secret
-- itself. Signing out, or a leaked cookie, is then a row change rather than a
-- redeploy with a new environment variable.
CREATE TABLE admin_sessions (
  id          TEXT PRIMARY KEY,
  token_label TEXT        NOT NULL,
  ip_hash     TEXT,
  created_at  TIMESTAMPTZ NOT NULL,
  expires_at  TIMESTAMPTZ NOT NULL,
  revoked_at  TIMESTAMPTZ
);

-- `resolveAdminSession` looks a session up by primary key and then filters on
-- these two, so this index is for the sweep that reaps dead rows rather than
-- for the hot path.
CREATE INDEX admin_sessions_live ON admin_sessions (expires_at, revoked_at);

-- Every attempt to authenticate, successful or not. Failures drive the
-- lockout; successes are kept because they end a failure streak, and because
-- "when did this token last work" is the first question asked when something
-- looks wrong.
--
-- ip_hash, never an address: the same salted-SHA-256 rule the rest of this
-- project follows (see src/lib/paint/client-ip.ts). It is NOT NULL because a
-- caller whose address cannot be trusted is refused before an attempt is
-- recorded, rather than sharing one anonymous bucket with every other such
-- caller — a shared bucket here would let anybody lock the operator out.
CREATE TABLE admin_login_attempts (
  id           TEXT PRIMARY KEY,
  ip_hash      TEXT        NOT NULL,
  token_label  TEXT,
  succeeded    BOOLEAN     NOT NULL,
  attempted_at TIMESTAMPTZ NOT NULL
);

-- Matches checkAdminLoginGate's WHERE (ip_hash = $1 AND attempted_at > $2) and
-- its ORDER BY attempted_at DESC, in that column order: equality first, then
-- the range the scan walks backwards.
CREATE INDEX admin_login_attempts_ip
  ON admin_login_attempts (ip_hash, attempted_at DESC);

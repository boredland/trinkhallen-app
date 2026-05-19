-- 0002_magic_links.sql
--
-- Single-use, time-bounded email login tokens. Stored hashed (SHA-256) so a
-- DB leak doesn't yield working login links; the cleartext token lives only
-- in the user's email + the URL.

CREATE TABLE magic_links (
  id            TEXT PRIMARY KEY,             -- random opaque id used as URL fragment
  token_hash    TEXT NOT NULL,                -- hex SHA-256 of the secret token
  email         TEXT NOT NULL,                -- the address the link was sent to
  expires_at    INTEGER NOT NULL,             -- unix seconds, 15 min from creation
  consumed_at   INTEGER,                      -- null until first redeem
  created_at    INTEGER NOT NULL,
  user_agent    TEXT,                         -- debug / abuse signal
  ip            TEXT
);

CREATE INDEX magic_links_email_idx       ON magic_links (email);
CREATE INDEX magic_links_expires_idx     ON magic_links (expires_at);

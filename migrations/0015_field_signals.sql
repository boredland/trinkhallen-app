-- 0015_field_signals.sql
--
-- Phase 0 of the Frische epic (#5, carve-out #7): the per-field signal log.
-- Confirm/dispute/fill rows land here; later phases compute confidence and
-- consensus over the accumulated history. The write-path enforces strict
-- verified-presence via verifyPresence from #4 — only in-range, accuracy-aware
-- fixes get through, so `verified` is always 1 for now (kept on the row so
-- the column shape survives if remote/unverified entries are ever introduced).
--
-- field_key is free-form so the table can accumulate signals for any field
-- (opening_hours, status, payment.*, tags.*, …) without further migrations.
-- The UNIQUE(user, kiosk, field, day) dedupe key matches the pattern already
-- in checkins — same-day re-confirms are silent no-ops via INSERT OR IGNORE.

CREATE TABLE field_signals (
  id              TEXT PRIMARY KEY,
  kiosk_id        TEXT NOT NULL,
  field_key       TEXT NOT NULL,
  action          TEXT NOT NULL CHECK (action IN ('confirm', 'dispute', 'fill')),
  asserted_value  TEXT,
  user_id         TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  verified        INTEGER NOT NULL,
  region_slug     TEXT NOT NULL,
  created_at      INTEGER NOT NULL,
  created_day     TEXT NOT NULL
);

CREATE UNIQUE INDEX field_signals_dedupe_idx
  ON field_signals(user_id, kiosk_id, field_key, created_day);
CREATE INDEX field_signals_field_idx  ON field_signals(kiosk_id, field_key);
CREATE INDEX field_signals_region_idx ON field_signals(region_slug, verified);
CREATE INDEX field_signals_user_idx   ON field_signals(user_id);

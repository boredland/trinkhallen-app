-- 0006_checkins.sql
--
-- Two changes:
--   1. New `checkins` table — silent event log of "Ich war hier" taps. No UI
--      reads it in V1; the schema is shaped so a future leaderboard layer can
--      query directly (region_slug + verified are the obvious indexed dims).
--   2. Extend reports.kind CHECK with the three kinds the gap-fill form can
--      produce: update_payment, update_tags, wrong_name. SQLite has no ALTER
--      DROP CONSTRAINT, so this is the standard rebuild-and-copy.

CREATE TABLE checkins (
  id          TEXT PRIMARY KEY,                -- uuid
  kiosk_id    TEXT NOT NULL,
  user_id     TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  region_slug TEXT NOT NULL,                   -- derived from kiosk.region path segment
  verified    INTEGER NOT NULL DEFAULT 0       -- 1 iff geolocation within 100m of kiosk
              CHECK (verified IN (0, 1)),
  created_at  INTEGER NOT NULL,
  created_day TEXT NOT NULL                    -- 'YYYY-MM-DD' — UNIQUE-indexed for per-day dedupe
);
CREATE UNIQUE INDEX checkins_dedupe_idx ON checkins (kiosk_id, user_id, created_day);
CREATE INDEX        checkins_region_idx ON checkins (region_slug, verified);
CREATE INDEX        checkins_user_idx   ON checkins (user_id);

CREATE TABLE reports_new (
  id         TEXT PRIMARY KEY,
  kiosk_id   TEXT NOT NULL,
  user_id    TEXT NOT NULL REFERENCES users (id),
  kind       TEXT NOT NULL CHECK (kind IN (
               'wrong_hours', 'wrong_address', 'wrong_name', 'closed',
               'duplicate', 'update_payment', 'update_tags', 'other'
             )),
  payload    TEXT,
  status     TEXT NOT NULL DEFAULT 'open'
             CHECK (status IN ('open', 'pr_opened', 'merged', 'dismissed')),
  pr_url     TEXT,
  approved_by    TEXT,
  approved_at    INTEGER,
  moderator_note TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
INSERT INTO reports_new
  SELECT id, kiosk_id, user_id, kind, payload, status, pr_url,
         approved_by, approved_at, moderator_note,
         created_at, updated_at
    FROM reports;
DROP TABLE reports;
ALTER TABLE reports_new RENAME TO reports;
CREATE INDEX reports_kiosk_idx  ON reports (kiosk_id);
CREATE INDEX reports_user_idx   ON reports (user_id);
CREATE INDEX reports_status_idx ON reports (status);

-- 0010_ph_observed_kind.sql
--
-- Extends reports.kind CHECK with `ph_open_observed`: an auto-filed report
-- created by the check-in handler when a *verified* check-in happens on a
-- public holiday at a kiosk whose opening_hours carries no PH clause. The
-- observation is one half of the PH-data-gap fix; the moderation queue
-- approves these and the patch appends `; PH open` to the hours string.
--
-- SQLite CHECK constraints aren't alterable in place, so rebuild reports
-- the same way 0006 did.

-- Schema mirrors 0006_checkins.sql's reports_new exactly except:
--   1. `kind` CHECK adds `ph_open_observed`.
--   2. `status` CHECK adds `approved` — moderation.ts has been writing this
--      value since the no-GitHub-App fallback landed, but the constraint
--      didn't allow it. The rebuild is a free chance to align the schema.
CREATE TABLE reports_new (
  id         TEXT PRIMARY KEY,
  kiosk_id   TEXT NOT NULL,
  user_id    TEXT NOT NULL REFERENCES users (id),
  kind       TEXT NOT NULL CHECK (kind IN (
               'wrong_hours', 'wrong_address', 'wrong_name', 'closed',
               'duplicate', 'update_payment', 'update_tags',
               'ph_open_observed', 'other'
             )),
  payload    TEXT,
  status     TEXT NOT NULL DEFAULT 'open'
             CHECK (status IN ('open', 'pr_opened', 'merged', 'dismissed', 'approved')),
  pr_url     TEXT,
  approved_by    TEXT,
  approved_at    INTEGER,
  moderator_note TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

INSERT INTO reports_new
  SELECT id, kiosk_id, user_id, kind, payload, status, pr_url,
         approved_by, approved_at, moderator_note, created_at, updated_at
    FROM reports;

DROP TABLE reports;
ALTER TABLE reports_new RENAME TO reports;

CREATE INDEX reports_kiosk_idx  ON reports (kiosk_id);
CREATE INDEX reports_user_idx   ON reports (user_id);
CREATE INDEX reports_status_idx ON reports (status);

-- 0014_checkin_accuracy_and_anomalies.sql
--
-- Strict verified-presence (#4) needs the GPS fix's reported accuracy so the
-- verify radius can absorb urban/indoor noise without waving everything
-- through. We persist both the accuracy and the measured distance — audit
-- trail today, calibration data tomorrow when the threshold/cap get tuned.
--
-- user_anomalies holds server-side backstop detections (impossible-travel
-- now; collusion/spoof patterns later). Moderators see open rows on
-- /moderate so the backstop is visible — not a silent metric.

ALTER TABLE checkins ADD COLUMN accuracy REAL;
ALTER TABLE checkins ADD COLUMN distance_m REAL;

CREATE TABLE user_anomalies (
  id          TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind        TEXT NOT NULL,
  payload     TEXT,
  created_at  INTEGER NOT NULL,
  reviewed_at INTEGER,
  reviewed_by TEXT REFERENCES users(id)
);
CREATE INDEX user_anomalies_open_idx ON user_anomalies(reviewed_at);
CREATE INDEX user_anomalies_user_idx ON user_anomalies(user_id);

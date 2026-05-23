-- 0009_fix_ratings_kiosks_fk.sql
--
-- The `ratings` table from 0001 still carries a foreign-key reference to
-- the long-dropped `kiosks` table (`kiosks` itself was removed in 0004 when
-- kiosk data moved to GeoJSON assets). Any DELETE/UPDATE on `ratings` via
-- the wrangler d1 CLI hits "no such table: main.kiosks" because SQLite
-- tries to resolve the FK at planning time.
--
-- The 0006 migration rebuilt `reports` with a plain TEXT `kiosk_id` (no FK
-- target) for the same reason. Mirror that here.

CREATE TABLE ratings_new (
  kiosk_id   TEXT NOT NULL,
  user_id    TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  stars      INTEGER NOT NULL CHECK (stars BETWEEN 1 AND 5),
  comment    TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (kiosk_id, user_id)
);

INSERT INTO ratings_new (kiosk_id, user_id, stars, comment, created_at, updated_at)
  SELECT kiosk_id, user_id, stars, comment, created_at, updated_at FROM ratings;

DROP TABLE ratings;
ALTER TABLE ratings_new RENAME TO ratings;

CREATE INDEX ratings_kiosk_idx ON ratings (kiosk_id);

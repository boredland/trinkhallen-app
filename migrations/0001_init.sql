-- 0001_init.sql — initial schema for trinkhallen.app
-- D1 (SQLite). Apply via `pnpm db:migrate:local` / `pnpm db:migrate:remote`.

-- ----------------------------------------------------------------------------
-- Kiosks: a runtime snapshot of the canonical GeoJSON in trinkhallen-data,
-- refreshed by the /api/sync webhook handler. The R*-tree index makes
-- bbox queries (`/api/kiosks?bbox=…`) micro-second cheap.
-- ----------------------------------------------------------------------------

CREATE TABLE kiosks (
  id            TEXT PRIMARY KEY,           -- e.g. "tk_fr_001" (region-prefixed)
  region        TEXT NOT NULL,              -- "de/hessen/frankfurt"
  name          TEXT NOT NULL,
  description   TEXT,
  address_json  TEXT NOT NULL,              -- JSON: { street, number, postalcode, city, district }
  hours_raw     TEXT,                       -- OSM `opening_hours` string
  tags_json     TEXT NOT NULL DEFAULT '[]', -- JSON array of tag slugs
  payment_json  TEXT,                       -- JSON: { cash, cards, contactless, girocard, mobile }
  lng           REAL NOT NULL,
  lat           REAL NOT NULL,
  sources_json  TEXT,                       -- JSON array of provenance objects
  updated_at    INTEGER NOT NULL            -- unix seconds
);

CREATE INDEX kiosks_region_idx ON kiosks (region);
CREATE INDEX kiosks_updated_idx ON kiosks (updated_at);

-- Spatial filter: composite (lng, lat) index for bbox WHERE-clause scans.
-- Plain B-tree, not rtree — D1 doesn't authorize CREATE VIRTUAL TABLE rtree
-- and for our scale (< 100k rows nationally) the difference is invisible.
CREATE INDEX kiosks_lnglat_idx ON kiosks (lng, lat);

-- ----------------------------------------------------------------------------
-- Users + sessions. Google SSO only; we never store passwords.
-- ----------------------------------------------------------------------------

CREATE TABLE users (
  id           TEXT PRIMARY KEY,            -- uuid
  google_sub   TEXT NOT NULL UNIQUE,
  email        TEXT NOT NULL,
  display_name TEXT,
  avatar_url   TEXT,
  role         TEXT NOT NULL DEFAULT 'user'
               CHECK (role IN ('user', 'moderator', 'admin')),
  created_at   INTEGER NOT NULL
);

CREATE TABLE sessions (
  id         TEXT PRIMARY KEY,              -- random opaque token, stored hashed-only
  user_id    TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  expires_at INTEGER NOT NULL,              -- unix seconds
  created_at INTEGER NOT NULL
);
CREATE INDEX sessions_user_idx ON sessions (user_id);
CREATE INDEX sessions_expires_idx ON sessions (expires_at);

-- ----------------------------------------------------------------------------
-- User-generated content. Subjective; never bleeds into the GitHub data repo.
-- ----------------------------------------------------------------------------

CREATE TABLE ratings (
  kiosk_id   TEXT NOT NULL REFERENCES kiosks (id) ON DELETE CASCADE,
  user_id    TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  stars      INTEGER NOT NULL CHECK (stars BETWEEN 1 AND 5),
  comment    TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (kiosk_id, user_id)
);
CREATE INDEX ratings_kiosk_idx ON ratings (kiosk_id);

CREATE TABLE reports (
  id         TEXT PRIMARY KEY,              -- uuid
  kiosk_id   TEXT NOT NULL REFERENCES kiosks (id) ON DELETE CASCADE,
  user_id    TEXT NOT NULL REFERENCES users (id),
  kind       TEXT NOT NULL
             CHECK (kind IN ('wrong_hours', 'wrong_address', 'closed', 'duplicate', 'other')),
  payload    TEXT,                          -- JSON proposed correction
  status     TEXT NOT NULL DEFAULT 'open'
             CHECK (status IN ('open', 'pr_opened', 'merged', 'dismissed')),
  pr_url     TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX reports_kiosk_idx ON reports (kiosk_id);
CREATE INDEX reports_user_idx ON reports (user_id);
CREATE INDEX reports_status_idx ON reports (status);

CREATE TABLE submissions (
  id         TEXT PRIMARY KEY,              -- uuid
  user_id    TEXT NOT NULL REFERENCES users (id),
  payload    TEXT NOT NULL,                 -- JSON proposed Feature
  status     TEXT NOT NULL DEFAULT 'pending'
             CHECK (status IN ('pending', 'pr_opened', 'merged', 'dismissed')),
  pr_url     TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX submissions_user_idx ON submissions (user_id);
CREATE INDEX submissions_status_idx ON submissions (status);

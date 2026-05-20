-- Kiosks are now served from per-region GeoJSON files baked into the Worker's
-- Assets bundle by scripts/import-data.ts at build time. The `kiosks` table and
-- the sync webhook are no longer the source of truth.
DROP TABLE IF EXISTS kiosks;

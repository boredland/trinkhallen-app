-- 0012_username_autogen.sql
--
-- Usernames move from user-chosen (set-once) to auto-generated at signup with a
-- single allowed rename. `username_changed_at` records whether the user has
-- spent their one change; it starts NULL for everyone — including users who
-- already picked a handle under the old rule — so all of them get exactly one
-- rename from this baseline. The auto-assigned handle does NOT set it.
--
-- Existing NULL-username rows are backfilled by scripts/backfill-usernames.ts
-- (run once, remote + local), which also purges the now-unused SSO
-- display_name. The display_name column itself is dropped in a later migration,
-- after this code is deployed everywhere.

ALTER TABLE users ADD COLUMN username_changed_at INTEGER;

-- Renamed-away handles are retired, never recycled, so nobody can assume a
-- prior public identity. Stored lowercased to match users_username_lower_idx.
CREATE TABLE retired_usernames (
  username   TEXT PRIMARY KEY,
  retired_at INTEGER NOT NULL
);

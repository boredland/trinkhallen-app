-- 0007_username.sql
--
-- Adds a user-settable handle distinct from `display_name`. The UI enforces
-- set-once (UPDATE … WHERE username IS NULL); column-level edits via the D1
-- console stay possible for moderation/abuse cases.
--
-- Nullable on purpose: existing rows stay valid, and the /me page surfaces a
-- "pick one" form until the user sets one.

ALTER TABLE users ADD COLUMN username TEXT;

-- Case-insensitive uniqueness — store as the user typed it (e.g. preserve
-- mixed-case if we ever loosen the validator), but block "Jonas" vs "jonas"
-- collisions at write time. The validator already forces lowercase today.
CREATE UNIQUE INDEX users_username_lower_idx ON users (lower(username));

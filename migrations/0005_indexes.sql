-- 0005_indexes.sql
--
-- Two indexes the audit caught:
--   users(email)     — auth.tsx looks users up by email on every Google sign-in
--                      and magic-link redeem. Without this, each login
--                      full-scans the users table.
--   ratings(user_id) — the profile page counts a user's ratings via
--                      `WHERE user_id = ?`. The composite PK
--                      (kiosk_id, user_id) doesn't help when user_id is the
--                      query key.

CREATE INDEX IF NOT EXISTS users_email_idx   ON users (email);
CREATE INDEX IF NOT EXISTS ratings_user_idx  ON ratings (user_id);

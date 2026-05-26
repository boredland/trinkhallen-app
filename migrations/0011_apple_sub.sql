-- 0011_apple_sub.sql
--
-- Apple Sign-In is required by App Store Review Guideline 4.8 for any
-- iOS app that exposes third-party SSO. We already wrap the PWA with
-- the Google login button visible, so the iOS submission will hit 4.8
-- without this. Add a separate column rather than reusing google_sub
-- so a single user can be linked to both providers (matches the
-- existing magic-link → Google link-up story).
--
-- UNIQUE so the upsert-by-sub path can rely on it. Nullable because
-- existing users (and any future magic-link-only signups) won't have
-- an Apple identity attached yet.

ALTER TABLE users ADD COLUMN apple_sub TEXT;
CREATE UNIQUE INDEX users_apple_sub_idx ON users (apple_sub);

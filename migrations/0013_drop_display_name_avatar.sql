-- 0013_drop_display_name_avatar.sql
--
-- The SSO display_name and avatar_url columns are no longer written or read by
-- the application: handles replace display_name for public attribution, and
-- the avatar was removed when the Google OAuth scope shrank to openid+email.
-- The values were purged in production already; now the columns themselves go.
--
-- Apply only AFTER the deploy that stops referencing these columns — otherwise
-- the still-running old code would SELECT a column that no longer exists.

ALTER TABLE users DROP COLUMN display_name;
ALTER TABLE users DROP COLUMN avatar_url;

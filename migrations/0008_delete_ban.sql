-- 0008_delete_ban.sql
--
-- Two additions:
--   1. Sentinel "deleted user" row. When a user deletes their account, any
--      contribution that has already been merged into trinkhallen-data
--      (reports / submissions with status='pr_opened' or 'merged') gets its
--      user_id repointed at this sentinel. We can't roll back a merged PR
--      that the moderation team accepted, but we *can* sever the link to
--      the real person. Everything else (ratings, comments, check-ins,
--      sessions, open reports/submissions) is hard-deleted.
--   2. `users.banned_at` for shadow-banning. NULL = normal account.
--      Non-NULL = ratings stop appearing to anyone *except* the banned
--      user themselves. Reports/submissions/check-ins keep flowing into
--      D1 so moderators can still inspect the abuse pattern.

INSERT INTO users (id, google_sub, email, display_name, avatar_url, role, created_at)
  VALUES (
    '00000000-0000-0000-0000-000000000000',
    'deleted:sentinel',
    'deleted@trinkhallen.app',
    'Gelöschtes Konto',
    NULL,
    'user',
    strftime('%s', 'now')
  );

ALTER TABLE users ADD COLUMN banned_at INTEGER;
CREATE INDEX users_banned_idx ON users (banned_at);

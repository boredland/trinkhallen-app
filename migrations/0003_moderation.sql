-- 0003_moderation.sql
--
-- Moderation metadata for reports + submissions. The actual decision flow
-- lives in /moderate; this just records who decided what and when, plus
-- an optional human-readable note shown back to the original submitter.
-- pr_url + status already exist from 0001_init.

ALTER TABLE reports     ADD COLUMN approved_by    TEXT;
ALTER TABLE reports     ADD COLUMN approved_at    INTEGER;
ALTER TABLE reports     ADD COLUMN moderator_note TEXT;

ALTER TABLE submissions ADD COLUMN approved_by    TEXT;
ALTER TABLE submissions ADD COLUMN approved_at    INTEGER;
ALTER TABLE submissions ADD COLUMN moderator_note TEXT;

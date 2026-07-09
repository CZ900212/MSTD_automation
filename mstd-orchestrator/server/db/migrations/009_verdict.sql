-- 009_verdict.sql：admit 判定落库（调试台"为什么没回"可观测）
ALTER TABLE inbox_events ADD COLUMN verdict TEXT;

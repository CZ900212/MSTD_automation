-- 014_nudge_watermark.sql：C3.5 持久 nudge 水位——记忆整理提醒按累计 user 轮次十位点
-- 事务 claim，进程重启不重复提醒（取代 transcript 模数式判断）。
ALTER TABLE agent_sessions ADD COLUMN memory_nudge_watermark BIGINT NOT NULL DEFAULT 0;

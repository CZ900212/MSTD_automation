-- 006_cron.sql：cron 任务表（Postgres 可移植）
CREATE TABLE IF NOT EXISTS cron_jobs (
  id TEXT PRIMARY KEY,
  schedule TEXT NOT NULL,          -- "30m" | "every 2h" | cron 表达式 | 一次性 ISO
  prompt TEXT NOT NULL,
  deliver_to TEXT NOT NULL,        -- sessionKey 或 oc_/ou_ 直投目标
  owner_open_id TEXT,
  enabled INTEGER NOT NULL DEFAULT 1,
  last_run_at BIGINT,
  created_at BIGINT NOT NULL
);

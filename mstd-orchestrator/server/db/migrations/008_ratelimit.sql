-- 008_ratelimit.sql：群主动发言记录（限额持久化，重启不清零）
CREATE TABLE IF NOT EXISTS proactive_log (
  id TEXT PRIMARY KEY,
  chat_id TEXT NOT NULL,
  ts BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_proactive_chat ON proactive_log(chat_id, ts);

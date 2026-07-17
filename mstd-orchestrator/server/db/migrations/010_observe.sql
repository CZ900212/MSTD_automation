-- 010_observe.sql：观察期拟发言记录（信号/噪声比统计）
CREATE TABLE IF NOT EXISTS observe_log (
  id TEXT PRIMARY KEY,
  chat_id TEXT NOT NULL,
  action TEXT NOT NULL,          -- quick_reply | escalate | no_reply
  text TEXT,
  ts BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_observe_chat ON observe_log(chat_id, ts);

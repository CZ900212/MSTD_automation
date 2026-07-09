-- 004_models.sql：token 记账（Postgres 可移植）
CREATE TABLE IF NOT EXISTS token_usage (
  id TEXT PRIMARY KEY,
  session_key TEXT NOT NULL,
  tokens BIGINT NOT NULL,
  day BIGINT NOT NULL,           -- epoch 日序号（UTC）
  ts BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_token_usage_day ON token_usage(day);
CREATE INDEX IF NOT EXISTS idx_token_usage_session ON token_usage(session_key, day);

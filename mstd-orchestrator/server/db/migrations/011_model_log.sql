-- 011_model_log.sql：模型链路可观测事件（降级/重试/预算命中/出站重试）落库，调试台消费
CREATE TABLE IF NOT EXISTS model_log (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,            -- model_retry | model_fallback | pipeline_error | brain_fallback | budget_exceeded | outbound_retry
  chain TEXT,                    -- fast | reason | respond（caller 事件）
  from_key TEXT,                 -- 失败/降级前的模型 key
  to_key TEXT,                   -- 降级目标模型 key
  session_key TEXT,
  attempt INTEGER,
  detail TEXT,
  ts BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_model_log_ts ON model_log(ts);
CREATE INDEX IF NOT EXISTS idx_model_log_kind ON model_log(kind, ts);

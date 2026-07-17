-- 020_reasoning_observability.sql
-- Task/dispatch observability columns on model_log (additive; 019 owns task tables).
-- Plan originally numbered this 019; 019 is reasoning_tasks on this tree.

ALTER TABLE model_log ADD COLUMN task_id TEXT;
ALTER TABLE model_log ADD COLUMN dispatch_id TEXT;
ALTER TABLE model_log ADD COLUMN run_id TEXT;
ALTER TABLE model_log ADD COLUMN decision TEXT;
ALTER TABLE model_log ADD COLUMN reason_code TEXT;
ALTER TABLE model_log ADD COLUMN latency_ms BIGINT;

CREATE INDEX IF NOT EXISTS idx_model_log_session_task_ts
  ON model_log(session_key, task_id, ts);
CREATE INDEX IF NOT EXISTS idx_model_log_dispatch_decision_ts
  ON model_log(dispatch_id, decision, ts);

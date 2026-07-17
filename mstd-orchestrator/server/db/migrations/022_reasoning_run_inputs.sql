-- 022_reasoning_run_inputs.sql
-- Durable tool-result/reinjection inputs attached to a reasoner run.

CREATE TABLE IF NOT EXISTS reasoning_run_inputs (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES reasoning_runs(id),
  task_id TEXT NOT NULL REFERENCES reasoning_tasks(id),
  parent_run_id TEXT REFERENCES reasoning_runs(id),
  origin_kind TEXT NOT NULL,
  origin_id TEXT NOT NULL,
  dispatch_id TEXT,
  session_version INTEGER NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'delivered', 'controlled')),
  brief TEXT NOT NULL,
  context_envelope_json TEXT,
  created_at BIGINT NOT NULL,
  delivered_at BIGINT,
  UNIQUE(origin_kind, origin_id)
);

CREATE INDEX IF NOT EXISTS idx_reasoning_run_inputs_pending
  ON reasoning_run_inputs(run_id, status, created_at);

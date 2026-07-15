-- 021_reasoning_runs.sql
-- Durable reasoner executions. Tasks remain long-lived; each execution is one run.

CREATE TABLE IF NOT EXISTS reasoning_runs (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES reasoning_tasks(id),
  origin_dispatch_id TEXT REFERENCES reasoning_dispatches(id),
  parent_run_id TEXT REFERENCES reasoning_runs(id),
  origin_kind TEXT NOT NULL,
  origin_id TEXT,
  brief TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL CHECK (status IN (
    'queued', 'running', 'closing', 'completed', 'failed', 'interrupted', 'cancelled'
  )),
  closure_mode TEXT NOT NULL CHECK (closure_mode IN ('required', 'silent_ok')),
  closure_state TEXT NOT NULL CHECK (closure_state IN (
    'open', 'pending_send', 'sent', 'safe_fallback_sent', 'silent_closed', 'cancelled'
  )),
  turn_id TEXT,
  resident_key TEXT,
  terminal_idempotency_key TEXT NOT NULL UNIQUE,
  terminal_message_id TEXT,
  failure_summary TEXT,
  created_at BIGINT NOT NULL,
  updated_at BIGINT NOT NULL,
  started_at BIGINT,
  completed_at BIGINT
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_reasoning_runs_one_open_per_task
  ON reasoning_runs(task_id)
  WHERE status IN ('queued', 'running', 'closing');

CREATE INDEX IF NOT EXISTS idx_reasoning_runs_recovery
  ON reasoning_runs(status, created_at, updated_at);

CREATE INDEX IF NOT EXISTS idx_reasoning_runs_task_timeline
  ON reasoning_runs(task_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_reasoning_runs_origin
  ON reasoning_runs(origin_kind, origin_id, created_at);

CREATE TABLE IF NOT EXISTS reasoning_run_dispatches (
  run_id TEXT NOT NULL REFERENCES reasoning_runs(id),
  dispatch_id TEXT NOT NULL REFERENCES reasoning_dispatches(id),
  relation TEXT NOT NULL CHECK (relation IN ('origin', 'attach', 'tool_result', 'reinject')),
  created_at BIGINT NOT NULL,
  PRIMARY KEY (run_id, dispatch_id, relation)
);

CREATE INDEX IF NOT EXISTS idx_reasoning_run_dispatches_dispatch
  ON reasoning_run_dispatches(dispatch_id, created_at);

-- 019_reasoning_tasks.sql
-- Responder–Dispatcher–Reasoner: durable tasks + dispatch outbox.
-- Numbering note: 018_simulator_trace.sql already occupies 018; this plan's
-- original "018" task persistence lands as 019 on the current tree.

CREATE TABLE IF NOT EXISTS reasoning_tasks (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES agent_sessions(id),
  title TEXT NOT NULL,
  summary TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL CHECK (status IN ('active', 'completed', 'failed', 'cancelled')),
  closure_mode TEXT NOT NULL CHECK (closure_mode IN ('required', 'silent_ok')),
  created_at BIGINT NOT NULL,
  updated_at BIGINT NOT NULL,
  completed_at BIGINT
);
CREATE INDEX IF NOT EXISTS idx_reasoning_tasks_session_status
  ON reasoning_tasks(session_id, status, updated_at);
CREATE INDEX IF NOT EXISTS idx_reasoning_tasks_session_updated
  ON reasoning_tasks(session_id, updated_at DESC);

CREATE TABLE IF NOT EXISTS reasoning_task_messages (
  task_id TEXT NOT NULL REFERENCES reasoning_tasks(id),
  message_id TEXT NOT NULL REFERENCES agent_messages(id),
  relation TEXT NOT NULL CHECK (relation IN ('source', 'steer', 'tool_result', 'handoff', 'closure')),
  created_at BIGINT NOT NULL,
  PRIMARY KEY (task_id, message_id, relation)
);
CREATE INDEX IF NOT EXISTS idx_reasoning_task_messages_message
  ON reasoning_task_messages(message_id);

CREATE TABLE IF NOT EXISTS reasoning_dispatches (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES agent_sessions(id),
  source_message_ids_json TEXT NOT NULL,
  source_batch_key TEXT NOT NULL,
  responder_message_id TEXT REFERENCES agent_messages(id),
  responder_action TEXT NOT NULL CHECK (responder_action IN ('reply', 'no_reply')),
  responder_text TEXT,
  outbound_idempotency_key TEXT,
  mode TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending_send', 'pending_review', 'running', 'done', 'failed')),
  verdict_json TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  created_at BIGINT NOT NULL,
  updated_at BIGINT NOT NULL,
  UNIQUE (session_id, source_batch_key),
  UNIQUE (outbound_idempotency_key),
  CHECK (
    (responder_action = 'reply'
      AND responder_text IS NOT NULL
      AND outbound_idempotency_key IS NOT NULL)
    OR
    (responder_action = 'no_reply'
      AND responder_text IS NULL
      AND outbound_idempotency_key IS NULL)
  )
);
CREATE INDEX IF NOT EXISTS idx_reasoning_dispatches_status
  ON reasoning_dispatches(status, updated_at);
CREATE INDEX IF NOT EXISTS idx_reasoning_dispatches_session
  ON reasoning_dispatches(session_id, created_at DESC);

-- P0 prompt-injection containment. raw_payload is currently PLAINTEXT and audit-only;
-- it is deliberately absent from FTS/model prompt paths. Do not describe this storage as
-- encrypted. Production KMS/envelope encryption and ciphertext migration remain required.
ALTER TABLE inbox_events ADD COLUMN raw_sha256 TEXT;

ALTER TABLE agent_messages ADD COLUMN replayable INTEGER NOT NULL DEFAULT 1;
ALTER TABLE agent_messages ADD COLUMN prompt_eligible INTEGER NOT NULL DEFAULT 1;
ALTER TABLE agent_messages ADD COLUMN memory_eligible INTEGER NOT NULL DEFAULT 1;
ALTER TABLE agent_messages ADD COLUMN security_label TEXT NOT NULL DEFAULT 'normal';
ALTER TABLE agent_messages ADD COLUMN provenance TEXT NOT NULL DEFAULT 'conversation';
ALTER TABLE agent_messages ADD COLUMN quarantine_id TEXT;

-- Every historical tool row was daemon-internal in the pre-017 schema. Retire it from all
-- model-bound surfaces during migration instead of trusting a future writer to relabel it.
UPDATE agent_messages
SET replayable = 0,
    prompt_eligible = 0,
    memory_eligible = 0,
    security_label = 'internal',
    provenance = 'tool_internal'
WHERE role = 'tool';
DELETE FROM agent_messages_fts
WHERE message_id IN (SELECT id FROM agent_messages WHERE provenance = 'tool_internal');

CREATE INDEX IF NOT EXISTS idx_agent_messages_prompt_eligible
  ON agent_messages(session_id, prompt_eligible, active, ts);
CREATE INDEX IF NOT EXISTS idx_agent_messages_memory_eligible
  ON agent_messages(session_id, memory_eligible, active, ts);

CREATE TABLE IF NOT EXISTS security_quarantine (
  id TEXT PRIMARY KEY,
  session_id TEXT REFERENCES agent_sessions(id),
  event_id TEXT,
  sender_open_id TEXT,
  raw_payload TEXT NOT NULL,
  payload_sha256 TEXT NOT NULL,
  raw_input_length BIGINT NOT NULL,
  truncated INTEGER NOT NULL DEFAULT 0,
  flags_json TEXT NOT NULL DEFAULT '[]',
  rule_version TEXT NOT NULL,
  source TEXT NOT NULL DEFAULT 'feishu_inbox',
  audit_json TEXT NOT NULL DEFAULT '{}',
  created_at BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_security_quarantine_session
  ON security_quarantine(session_id, created_at);
CREATE INDEX IF NOT EXISTS idx_security_quarantine_event
  ON security_quarantine(event_id);

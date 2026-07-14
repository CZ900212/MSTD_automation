-- 018_simulator_trace.sql
-- 仿真评测：贯穿 platform message / sender app 身份，可阅卷 turn trace。
-- 列名使用中性 decision_*（非 triage_*），便于应答机架构迁移后复用。
-- pipeline: legacy | responder（默认 legacy）
-- 迁移编号规则：实施时取当时下一个空号；本文件落地时 017 已占用故为 018。

ALTER TABLE inbox_events ADD COLUMN platform_message_id TEXT;
ALTER TABLE inbox_events ADD COLUMN sender_app_id TEXT;
ALTER TABLE inbox_events ADD COLUMN source TEXT NOT NULL DEFAULT 'feishu';
ALTER TABLE inbox_events ADD COLUMN turn_trace_id TEXT;

CREATE INDEX IF NOT EXISTS idx_inbox_platform_message ON inbox_events(platform_message_id);
CREATE INDEX IF NOT EXISTS idx_inbox_turn_trace ON inbox_events(turn_trace_id);
CREATE INDEX IF NOT EXISTS idx_inbox_sender_app ON inbox_events(sender_app_id);

CREATE TABLE IF NOT EXISTS gateway_turn_trace (
  trace_id TEXT PRIMARY KEY,
  session_key TEXT NOT NULL,
  mode TEXT NOT NULL,
  source TEXT NOT NULL,
  pipeline TEXT NOT NULL DEFAULT 'legacy',
  input_event_ids_json TEXT NOT NULL,
  input_message_ids_json TEXT NOT NULL,
  received_at BIGINT NOT NULL,
  flushed_at BIGINT NOT NULL,
  decision_action TEXT,
  decision_source TEXT,
  decision_guard TEXT,
  decision_provider TEXT,
  decision_latency_ms BIGINT,
  business_turn_id TEXT,
  ack_message_id TEXT,
  ack_sent_at BIGINT,
  terminal_message_id TEXT,
  terminal_sent_at BIGINT,
  terminal_outcome TEXT,
  status TEXT NOT NULL,
  updated_at BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_gateway_turn_session ON gateway_turn_trace(session_key, flushed_at);
CREATE INDEX IF NOT EXISTS idx_gateway_turn_business ON gateway_turn_trace(business_turn_id);
CREATE INDEX IF NOT EXISTS idx_gateway_turn_status ON gateway_turn_trace(status, updated_at);

CREATE TABLE IF NOT EXISTS simulator_nonces (
  nonce TEXT PRIMARY KEY,
  seen_at BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_simulator_nonces_seen ON simulator_nonces(seen_at);

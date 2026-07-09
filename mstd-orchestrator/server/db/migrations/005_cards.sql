-- 005_cards.sql：确认卡关联（Postgres 可移植）
CREATE TABLE IF NOT EXISTS confirm_cards (
  id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL REFERENCES orch_jobs(id),
  message_id TEXT,
  session_key TEXT,
  initiator_open_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',   -- pending | executing | done | partial_failed | cancelled | expired
  created_at BIGINT NOT NULL,
  updated_at BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_confirm_cards_message ON confirm_cards(message_id);
CREATE INDEX IF NOT EXISTS idx_confirm_cards_job ON confirm_cards(job_id);

-- 003_agent_core.sql（Postgres 可移植：显式主键、epoch BIGINT、JSON 存 TEXT；FTS5 除外）
CREATE TABLE IF NOT EXISTS agent_sessions (
  id TEXT PRIMARY KEY,
  session_key TEXT NOT NULL UNIQUE,
  kind TEXT NOT NULL,                       -- p2p | group | cron | debug
  chat_id TEXT,
  title TEXT,
  status TEXT NOT NULL DEFAULT 'active',    -- active | archived
  version INTEGER NOT NULL DEFAULT 0,       -- 会话版本号（过时回复判定）
  created_at BIGINT NOT NULL,
  updated_at BIGINT NOT NULL
);

CREATE TABLE IF NOT EXISTS agent_messages (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES agent_sessions(id),
  role TEXT NOT NULL,                       -- user | assistant | tool | system
  sender_open_id TEXT,
  sender_name TEXT,
  content TEXT NOT NULL,
  observed INTEGER NOT NULL DEFAULT 0,      -- 旁听未回复标记
  active INTEGER NOT NULL DEFAULT 1,        -- 软删除
  platform_message_id TEXT,
  ts BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_agent_messages_session ON agent_messages(session_id, ts);

CREATE TABLE IF NOT EXISTS group_policies (
  chat_id TEXT PRIMARY KEY,
  policy TEXT NOT NULL DEFAULT 'mention_only',  -- disabled | mention_only | ambient
  hourly_proactive_limit INTEGER NOT NULL DEFAULT 4,
  updated_at BIGINT NOT NULL
);

CREATE TABLE IF NOT EXISTS inbox_events (
  event_id TEXT PRIMARY KEY,
  chat_id TEXT,
  content_md5 TEXT,
  ts BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_inbox_events_md5 ON inbox_events(chat_id, content_md5, ts);

CREATE VIRTUAL TABLE IF NOT EXISTS agent_messages_fts USING fts5(
  message_id UNINDEXED, session_id UNINDEXED, content, tokenize='trigram'
);

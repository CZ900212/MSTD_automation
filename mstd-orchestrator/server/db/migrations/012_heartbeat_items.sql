-- 012_heartbeat_items.sql：owner-bound 心跳提醒队列（取代可注入的 HEARTBEAT.md 行协议）。
-- 时间一律 epoch ms;ISO 只在 API 边界解析。owner_session_key 落库后不可变（无 UPDATE 面）。
-- CHECK：普通条目 deliver_to 必须等于 owner;跨会话条目必须挂已确认写动作（source_action_id）。
CREATE TABLE IF NOT EXISTS heartbeat_items (
  id TEXT PRIMARY KEY,
  owner_session_key TEXT NOT NULL,
  deliver_to TEXT NOT NULL,
  due_at BIGINT NOT NULL,
  text TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',   -- pending | delivering | delivered | cancelled | quarantined
  claim_token TEXT,
  claimed_at BIGINT,
  source_action_id TEXT UNIQUE REFERENCES job_actions(id),
  attempt_count INTEGER NOT NULL DEFAULT 0,
  next_attempt_at BIGINT NOT NULL DEFAULT 0,
  last_error TEXT,
  created_at BIGINT NOT NULL,
  updated_at BIGINT NOT NULL,
  delivered_at BIGINT,
  CHECK (owner_session_key = deliver_to OR source_action_id IS NOT NULL)
);
CREATE INDEX IF NOT EXISTS idx_heartbeat_due ON heartbeat_items(status, next_attempt_at, due_at, id);
CREATE INDEX IF NOT EXISTS idx_heartbeat_owner ON heartbeat_items(owner_session_key, status);

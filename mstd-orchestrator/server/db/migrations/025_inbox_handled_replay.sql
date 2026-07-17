-- 入站 at-most-once 缺口收口：lark-cli 已 ack 的事件在 debounce 窗口内崩溃即永久丢失
-- （与出站 pending_send 恢复不对称）。handled=0 表示已去重落库但尚未交给回合处理；
-- replay_json 存规范化事件全量（敏感事件不存，fail-safe 不回放）。
-- 既有行默认 handled=1：历史事件一律不回放。
ALTER TABLE inbox_events ADD COLUMN handled INTEGER NOT NULL DEFAULT 1;
ALTER TABLE inbox_events ADD COLUMN replay_json TEXT;
CREATE INDEX IF NOT EXISTS idx_inbox_unhandled ON inbox_events(handled) WHERE handled = 0;

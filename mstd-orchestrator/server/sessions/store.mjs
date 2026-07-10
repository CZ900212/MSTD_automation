import { randomUUID } from "node:crypto";

export function createSessionStore(db) {
  const getBySessionKey = db.prepare("SELECT * FROM agent_sessions WHERE session_key = ?");
  const insertSession = db.prepare(
    `INSERT INTO agent_sessions (id, session_key, kind, chat_id, title, status, version, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, 'active', 0, ?, ?)`
  );
  const insertMessage = db.prepare(
    `INSERT INTO agent_messages (id, session_id, role, sender_open_id, sender_name, content, observed, active, platform_message_id, ts)
     VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`
  );
  const insertFts = db.prepare(
    "INSERT INTO agent_messages_fts (message_id, session_id, content) VALUES (?, ?, ?)"
  );
  const touchSession = db.prepare(
    "UPDATE agent_sessions SET updated_at = CASE WHEN updated_at < ? THEN ? ELSE updated_at END WHERE id = ?"
  );

  function getOrCreate(sessionKey, meta = {}, now = Date.now()) {
    const found = getBySessionKey.get(sessionKey);
    if (found) return found;
    const id = randomUUID();
    insertSession.run(id, sessionKey, meta.kind ?? sessionKey.split(":")[1] ?? "p2p",
      meta.chatId ?? null, meta.title ?? null, now, now);
    return getBySessionKey.get(sessionKey);
  }

  function append(sessionId, msg) {
    const id = randomUUID();
    const ts = msg.ts ?? Date.now();
    insertMessage.run(id, sessionId, msg.role, msg.senderOpenId ?? null, msg.senderName ?? null,
      msg.content, msg.observed ? 1 : 0, msg.platformMessageId ?? null, ts);
    insertFts.run(id, sessionId, msg.content);
    touch(sessionId, ts);
    return { id, sessionId, ...msg, ts };
  }

  function transcript(sessionId, { limit = 200 } = {}) {
    return db.prepare(
      "SELECT * FROM agent_messages WHERE session_id = ? AND active = 1 ORDER BY ts LIMIT ?"
    ).all(sessionId, limit);
  }

  function softDelete(messageId) {
    db.prepare("UPDATE agent_messages SET active = 0 WHERE id = ?").run(messageId);
  }

  function bumpVersion(sessionId) {
    db.prepare("UPDATE agent_sessions SET version = version + 1 WHERE id = ?").run(sessionId);
    return db.prepare("SELECT version FROM agent_sessions WHERE id = ?").get(sessionId).version;
  }

  // 未消费的旁听消息（群@ pending 窗口），取最近 limit 条
  function recentObserved(sessionId, { limit = 50 } = {}) {
    return db.prepare(
      `SELECT * FROM (
         SELECT * FROM agent_messages
         WHERE session_id = ? AND observed = 1 AND observed_consumed = 0 AND active = 1
         ORDER BY ts DESC LIMIT ?
       ) ORDER BY ts`
    ).all(sessionId, limit);
  }

  function markObservedConsumed(messageIds) {
    const stmt = db.prepare("UPDATE agent_messages SET observed_consumed = 1 WHERE id = ?");
    for (const id of messageIds) stmt.run(id);
  }

  function touch(sessionId, now = Date.now()) {
    touchSession.run(now, now, sessionId);
  }

  return { getOrCreate, append, transcript, softDelete, bumpVersion, touch, recentObserved, markObservedConsumed };
}

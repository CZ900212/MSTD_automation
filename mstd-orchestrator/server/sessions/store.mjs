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

  // 最近 n 条(时序返回)。transcript 是 ORDER BY ts 取最早,勿用于"近期"语义。
  // 同 ts 用 rowid 定序(uuid 主键排序随机)——SQLite 方言例外,Postgres 迁移换自增主键,同 FTS5 先例(README)。
  // 注:当查询走 (session_id, ts) 索引时,索引项内 rowid 天然有序,显式 rowid DESC 与隐式序等价;
  // 该子句是对查询计划变更(索引重建/删除)的防御,黑盒测试不可判别,勿删。
  function recent(sessionId, { limit = 50, roles = null } = {}) {
    if (Array.isArray(roles) && roles.length === 0) return [];        // 空角色集=空结果,不等于"全角色"
    const n = Number.isInteger(limit) && limit > 0 ? limit : 50;      // SQLite LIMIT 负数=无上限,钳掉
    const roleClause = roles?.length ? ` AND role IN (${roles.map(() => "?").join(",")})` : "";
    const rows = db.prepare(
      `SELECT * FROM agent_messages WHERE session_id = ? AND active = 1${roleClause} ORDER BY ts DESC, rowid DESC LIMIT ?`
    ).all(...[sessionId, ...(roles ?? []), n]);
    return rows.reverse();
  }

  // 重放集:全部压缩摘要(时序)+ 近况原文——多轮压缩后早期历史仍在,不许只取最新一份摘要
  function replaySet(sessionId, { limit = 50 } = {}) {
    const sums = db.prepare(
      "SELECT content FROM agent_messages WHERE session_id = ? AND active = 1 AND role = 'system' ORDER BY ts, rowid"
    ).all(sessionId).filter((r) => r.content?.startsWith("〔压缩摘要〕"));
    const summary = sums.length ? sums.map((r) => r.content).join("\n") : null;
    return { summary, messages: recent(sessionId, { limit, roles: ["user", "assistant", "tool"] }) };
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

  return { getOrCreate, append, transcript, recent, replaySet, softDelete, bumpVersion, touch, recentObserved, markObservedConsumed };
}

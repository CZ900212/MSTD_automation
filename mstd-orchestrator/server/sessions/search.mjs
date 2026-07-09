// session_search：FTS 跨会话检索 + 权限过滤（隔离铁律延伸到检索面）。
// FTS5 trigram 为 SQLite 专属；PG 迁移时本模块整体换 pg_trgm 实现。
import { parseSessionKey } from "./session-key.mjs";

export function createSessionSearch(db) {
  // 权限 → 允许的 session_key 前缀；null = 不限（debug/cron 管理面）
  function scopePrefix(sessionKey) {
    let parsed;
    try { parsed = parseSessionKey(sessionKey); } catch { return "__deny__"; }
    if (parsed.kind === "group") return `feishu:group:${parsed.chatId}`;
    if (parsed.kind === "p2p") return `feishu:p2p:${parsed.openId}`;
    return null; // cron/debug
  }

  function run({ query, limit = 10 }, ctx) {
    if (!query?.trim()) return { ok: false, error: "query 必填" };
    const prefix = scopePrefix(ctx.sessionKey);
    if (prefix === "__deny__") return { ok: false, error: "非法会话" };

    const useMatch = query.length >= 3;
    const base = `
      SELECT s.session_key AS sessionKey, m.content AS content, m.ts AS ts
      FROM agent_messages_fts f
      JOIN agent_messages m ON m.id = f.message_id
      JOIN agent_sessions s ON s.id = m.session_id
      WHERE m.active = 1
        AND ${useMatch ? "agent_messages_fts MATCH ?" : "f.content LIKE ?"}
        ${prefix ? "AND (s.session_key = ? OR s.session_key LIKE ?)" : ""}
      ORDER BY m.ts DESC
      LIMIT ?`;
    const params = [useMatch ? query : `%${query}%`];
    if (prefix) params.push(prefix, `${prefix}:%`);
    params.push(limit);
    const hits = db.prepare(base).all(...params);
    return { ok: true, hits };
  }

  return { run };
}

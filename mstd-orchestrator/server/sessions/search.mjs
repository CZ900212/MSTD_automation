// session_search：FTS 跨会话检索 + 权限过滤（隔离铁律延伸到检索面）。
// FTS5 trigram 为 SQLite 专属；PG 迁移时本模块整体换 pg_trgm 实现。
import { parseSessionKey } from "./session-key.mjs";

export function createSessionSearch(db) {
  // 权限 → 允许的 session_key 前缀。不存在"不限范围"：debug 只搜自会话，
  // cron/未知一律拒绝（防注入计划批次 E：不保留 null=无限范围的管理面后门）。
  function scopePrefix(sessionKey) {
    let parsed;
    try { parsed = parseSessionKey(sessionKey); } catch { return "__deny__"; }
    if (parsed.kind === "group") return `feishu:group:${parsed.chatId}`;
    if (parsed.kind === "p2p") return `feishu:p2p:${parsed.openId}`;
    if (parsed.kind === "debug") return sessionKey;
    return "__deny__";
  }

  function run({ query, limit = 10 }, ctx) {
    if (!query?.trim()) return { ok: false, error: "query 必填" };
    const prefix = scopePrefix(ctx.sessionKey);
    if (prefix === "__deny__") return { ok: false, error: "非法会话" };
    // limit 模型可控，钳到闭区间防止负数/超大值被 SQLite 当作无上限
    const safeLimit = Math.min(Math.max(Number.isFinite(limit) ? Math.trunc(limit) : 10, 1), 50);

    const useMatch = query.length >= 3;
    const base = `
      SELECT s.session_key AS sessionKey, m.content AS content, m.ts AS ts
      FROM agent_messages_fts f
      JOIN agent_messages m ON m.id = f.message_id
      JOIN agent_sessions s ON s.id = m.session_id
      WHERE m.active = 1
        AND m.prompt_eligible = 1
        AND m.security_label = 'normal'
        AND m.provenance = 'conversation'
        AND ${useMatch ? "agent_messages_fts MATCH ?" : "f.content LIKE ?"}
        ${prefix ? "AND (s.session_key = ? OR s.session_key LIKE ?)" : ""}
      ORDER BY m.ts DESC
      LIMIT ?`;
    const params = [useMatch ? query : `%${query}%`];
    if (prefix) params.push(prefix, `${prefix}:%`);
    params.push(safeLimit);
    // query 直接喂给 FTS5 MATCH，模型可控内容可能含未配对引号/括号等触发 FTS 语法错误；
    // 降级为空结果而非让工具整体抛错中断调用方
    try {
      const hits = db.prepare(base).all(...params);
      return { ok: true, hits };
    } catch (e) {
      return { ok: true, hits: [], error: `FTS 查询语法错误已降级为空结果：${e.message}` };
    }
  }

  return { run };
}

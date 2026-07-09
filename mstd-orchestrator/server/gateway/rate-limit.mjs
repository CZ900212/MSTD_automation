// 群主动发言限额（防刷屏硬限制）：每群每小时 ≤ group_policies.hourly_proactive_limit（默认 4）
// + 连续主动消息 ≤2（有人类消息间隔后重置）。计数持久化（proactive_log），重启不清零。
import { randomUUID } from "node:crypto";

const HOUR = 3600_000;
const MAX_CONSECUTIVE = 2;
const DEFAULT_HOURLY = 4;

export function createProactiveLimiter(db) {
  const hourlyLimitOf = (chatId) =>
    db.prepare("SELECT hourly_proactive_limit FROM group_policies WHERE chat_id = ?").get(chatId)?.hourly_proactive_limit
    ?? DEFAULT_HOURLY;

  function allow(chatId, now = Date.now()) {
    const hourly = db.prepare(
      "SELECT COUNT(*) n FROM proactive_log WHERE chat_id = ? AND ts > ?"
    ).get(chatId, now - HOUR).n;
    if (hourly >= hourlyLimitOf(chatId)) return false;

    // 连续上限：最后一条人类消息之后的主动消息数
    const lastHuman = db.prepare(
      `SELECT MAX(m.ts) t FROM agent_messages m
       JOIN agent_sessions s ON s.id = m.session_id
       WHERE s.chat_id = ? AND m.role = 'user' AND m.active = 1`
    ).get(chatId)?.t ?? 0;
    const consecutive = db.prepare(
      "SELECT COUNT(*) n FROM proactive_log WHERE chat_id = ? AND ts > ?"
    ).get(chatId, lastHuman).n;
    return consecutive < MAX_CONSECUTIVE;
  }

  function record(chatId, now = Date.now()) {
    db.prepare("INSERT INTO proactive_log (id, chat_id, ts) VALUES (?, ?, ?)").run(randomUUID(), chatId, now);
  }

  return { allow, record };
}

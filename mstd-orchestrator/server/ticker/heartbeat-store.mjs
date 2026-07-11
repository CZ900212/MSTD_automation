// C0.4 心跳提醒结构化存储：owner-bound 队列（heartbeat_items 表）。
// 铁律：owner_session_key 落库后不可变;普通 Pi 只能 addOwned（deliverTo 服务端固定 = owner,
// 且 owner 仅限 canonical feishu:p2p:*/feishu:group:*——cron/debug 即使持合法内部 token 也拒绝）;
// 跨会话条目只能由已确认写路径调 addApproved（以 source_action_id 为幂等键）。
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, renameSync } from "node:fs";
import { parseSessionKey, buildSessionKey } from "../sessions/session-key.mjs";
import { parseStrictIsoWithTimezone } from "../time/strict-iso.mjs";

const TEXT_MAX = 4000;
const BACKOFF_BASE_MS = 60_000;
const BACKOFF_CAP_MS = 3_600_000;

// canonical round-trip：parse 后必须能原样重建（拒缺 id/多余段）,且 kind 仅 p2p/group
function canonicalDeliverableKey(key) {
  if (typeof key !== "string" || !key) return null;
  let parsed;
  try { parsed = parseSessionKey(key); } catch { return null; }
  if (parsed.kind !== "p2p" && parsed.kind !== "group") return null;
  let rebuilt;
  try { rebuilt = buildSessionKey(parsed); } catch { return null; }
  return rebuilt === key ? key : null;
}

function validateDueAndText({ dueIso, text }) {
  const dueAt = parseStrictIsoWithTimezone(dueIso);
  if (dueAt === null) return { error: "due_iso 非法：需带时区的严格 ISO 8601（如 2026-07-12T09:00:00+08:00）" };
  if (typeof text !== "string" || !text.trim()) return { error: "text 必填" };
  if (text.includes("\u0000")) return { error: "text 含非法控制字符" };
  if (text.length > TEXT_MAX) return { error: `text 超长（上限 ${TEXT_MAX} 字符）` };
  return { dueAt };
}

export function createHeartbeatStore(db, { now = Date.now } = {}) {
  const insert = db.prepare(
    `INSERT INTO heartbeat_items
       (id, owner_session_key, deliver_to, due_at, text, status, source_action_id, attempt_count, next_attempt_at, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, 'pending', ?, 0, 0, ?, ?)`
  );
  const bySourceAction = db.prepare("SELECT id FROM heartbeat_items WHERE source_action_id = ?");

  function addOwned({ ownerSessionKey, dueIso, text }) {
    const owner = canonicalDeliverableKey(ownerSessionKey);
    if (!owner) return { ok: false, error: "owner 会话键非法：仅 canonical feishu:p2p:*/feishu:group:* 可自建提醒" };
    const v = validateDueAndText({ dueIso, text });
    if (v.error) return { ok: false, error: v.error };
    const id = randomUUID();
    const ts = now();
    insert.run(id, owner, owner, v.dueAt, text, null, ts, ts);   // deliverTo 服务端固定 = owner
    return { ok: true, itemId: id };
  }

  function addApproved({ ownerSessionKey, deliverTo, dueIso, text, sourceActionId }) {
    if (typeof sourceActionId !== "string" || !sourceActionId) {
      return { ok: false, error: "addApproved 必须携带 sourceActionId（已确认写动作的 action row id）" };
    }
    if (typeof ownerSessionKey !== "string" || !ownerSessionKey) return { ok: false, error: "ownerSessionKey 必填" };
    const target = canonicalDeliverableKey(deliverTo);
    if (!target) return { ok: false, error: "deliver_to 非法：仅 canonical feishu:p2p:*/feishu:group:*" };
    const v = validateDueAndText({ dueIso, text });
    if (v.error) return { ok: false, error: v.error };
    const existing = bySourceAction.get(sourceActionId);
    if (existing) return { ok: true, itemId: existing.id, deduped: true };
    const id = randomUUID();
    const ts = now();
    try {
      insert.run(id, ownerSessionKey, target, v.dueAt, text, sourceActionId, ts, ts);
    } catch (e) {
      const raced = bySourceAction.get(sourceActionId);            // UNIQUE 撞车 → 幂等返回已有条目
      if (raced) return { ok: true, itemId: raced.id, deduped: true };
      return { ok: false, error: String(e?.message ?? e) };
    }
    return { ok: true, itemId: id };
  }

  function listOwned(ownerSessionKey) {
    return db.prepare(
      `SELECT id, due_at, text, deliver_to, status, attempt_count, last_error
       FROM heartbeat_items WHERE owner_session_key = ? AND status = 'pending'
       ORDER BY due_at, id`
    ).all(ownerSessionKey);
  }

  function removeOwned({ ownerSessionKey, itemId }) {
    if (typeof itemId !== "string" || !itemId) return { ok: false, error: "item_id 必填" };
    const r = db.prepare(
      "UPDATE heartbeat_items SET status = 'cancelled', updated_at = ? WHERE id = ? AND owner_session_key = ? AND status = 'pending'"
    ).run(now(), itemId, ownerSessionKey);
    return r.changes === 1 ? { ok: true } : { ok: false, error: "未命中（只能取消本会话的 pending 提醒）" };
  }

  // 单事务 claim：选一条 due row 并用随机 claim token 标记 delivering;并发只有一个赢家
  const claimTx = db.transaction((nowTs) => {
    const row = db.prepare(
      `SELECT * FROM heartbeat_items
       WHERE status = 'pending' AND due_at <= ? AND next_attempt_at <= ?
       ORDER BY due_at, id LIMIT 1`
    ).get(nowTs, nowTs);
    if (!row) return null;
    const token = randomUUID();
    const r = db.prepare(
      "UPDATE heartbeat_items SET status = 'delivering', claim_token = ?, claimed_at = ?, updated_at = ? WHERE id = ? AND status = 'pending'"
    ).run(token, nowTs, nowTs, row.id);
    if (r.changes !== 1) return null;
    return { ...row, status: "delivering", claim_token: token, claimed_at: nowTs };
  });

  function claimDue(nowTs = now()) {
    return claimTx(nowTs);
  }

  function markDelivered({ itemId, claimToken, now: nowTs = now() }) {
    const r = db.prepare(
      "UPDATE heartbeat_items SET status = 'delivered', delivered_at = ?, claim_token = NULL, updated_at = ? WHERE id = ? AND claim_token = ? AND status = 'delivering'"
    ).run(nowTs, nowTs, itemId, claimToken);
    return r.changes === 1 ? { ok: true } : { ok: false, error: "claim token 不匹配或状态已变" };
  }

  const retryTx = db.transaction(({ itemId, claimToken, error, nowTs }) => {
    const row = db.prepare(
      "SELECT attempt_count FROM heartbeat_items WHERE id = ? AND claim_token = ? AND status = 'delivering'"
    ).get(itemId, claimToken);
    if (!row) return { ok: false, error: "claim token 不匹配或状态已变" };
    const attempt = row.attempt_count + 1;
    const backoff = Math.min(BACKOFF_BASE_MS * 2 ** (attempt - 1), BACKOFF_CAP_MS);   // 有上限退避
    db.prepare(
      `UPDATE heartbeat_items
       SET status = 'pending', claim_token = NULL, claimed_at = NULL,
           attempt_count = ?, next_attempt_at = ?, last_error = ?, updated_at = ?
       WHERE id = ? AND claim_token = ? AND status = 'delivering'`
    ).run(attempt, nowTs + backoff, String(error ?? "").slice(0, 500), nowTs, itemId, claimToken);
    return { ok: true, nextAttemptAt: nowTs + backoff };
  });

  function markRetry({ itemId, claimToken, error, now: nowTs = now() }) {
    return retryTx({ itemId, claimToken, error, nowTs });
  }

  // 启动恢复：只把超时的 delivering claim 释放回 pending（进程崩溃遗留）
  function releaseStale(nowTs = now(), { staleMs = 600_000 } = {}) {
    const r = db.prepare(
      "UPDATE heartbeat_items SET status = 'pending', claim_token = NULL, claimed_at = NULL, updated_at = ? WHERE status = 'delivering' AND claimed_at <= ?"
    ).run(nowTs, nowTs - staleMs);
    return { released: r.changes };
  }

  // 存量 HEARTBEAT.md 无法证明 owner：整文件原子 rename 隔离,零解析零导入零执行
  function quarantineLegacy(legacyPath, nowTs = now()) {
    if (!legacyPath || !existsSync(legacyPath)) return { quarantined: false };
    const content = readFileSync(legacyPath, "utf8");
    const lines = content.split("\n").filter((l) => l.trim()).length;
    const target = legacyPath.replace(/\.md$/, "") + `.legacy-quarantine.${nowTs}.md`;
    renameSync(legacyPath, target);
    return { quarantined: true, path: target, lines };
  }

  return { addOwned, addApproved, listOwned, removeOwned, claimDue, markDelivered, markRetry, releaseStale, quarantineLegacy };
}

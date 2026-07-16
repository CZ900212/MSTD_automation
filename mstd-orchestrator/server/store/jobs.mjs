import { randomUUID } from "node:crypto";

// 会话过期归档豁免的"活跃 job"状态集。'executing'：Task 4B 确认事务提交→异步执行窗口，
// 该窗口内 owner 会话不得被 session-expiry 归档。
export const ACTIVE_JOB_STATUSES = ["running", "queued", "running_readonly", "awaiting_confirm", "executing"];

export function hasActiveJobForSession(db, sessionKey) {
  const placeholders = ACTIVE_JOB_STATUSES.map(() => "?").join(",");
  // 精确匹配顶层 sessionKey 字段（background.mjs / confirm-flow.mjs 两个生产方均为此形状）。
  // 旧实现 LIKE '%key%' 是裸子串匹配：会话键互为前缀（ou_x vs ou_xy）或键出现在 brief 文本里
  // 都会误判"有活跃 job"而错误豁免归档。json_valid 守卫防单行损坏 params 让整个 sweep 抛错。
  return !!db.prepare(
    `SELECT 1 FROM orch_jobs WHERE status IN (${placeholders})
       AND json_valid(params_json) AND json_extract(params_json, '$.sessionKey') = ? LIMIT 1`
  ).get(...ACTIVE_JOB_STATUSES, sessionKey);
}

export function createJob(db, { templateId, title = null, paramsJson = null, status, createdBy = null }, now = Date.now()) {
  const id = randomUUID();
  db.prepare(
    "INSERT INTO orch_jobs (id, template_id, title, params_json, status, created_by, thread_ref, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?)"
  ).run(id, templateId, title, paramsJson, status, createdBy, null, now, now);
  return getJobRow(db, id);
}

export function getJobRow(db, id) {
  return db.prepare("SELECT * FROM orch_jobs WHERE id = ?").get(id);
}

export function updateJobStatus(db, id, status, now = Date.now()) {
  db.prepare("UPDATE orch_jobs SET status = ?, updated_at = ? WHERE id = ?").run(status, now, id);
}

export function saveJobDraft(db, jobId, { cardText = null, itemsJson = null, actionSetJson = null, rawOutput = null }) {
  db.prepare(
    "INSERT INTO job_draft (job_id, card_text, items_json, action_set_json, raw_output) VALUES (?,?,?,?,?) " +
    "ON CONFLICT (job_id) DO UPDATE SET card_text=excluded.card_text, items_json=excluded.items_json, " +
    "action_set_json=excluded.action_set_json, raw_output=excluded.raw_output"
  ).run(jobId, cardText, itemsJson, actionSetJson, rawOutput);
}

export function listJobs(db, { status = null, mine = null } = {}) {
  const where = [];
  const args = [];
  if (status) { where.push("status = ?"); args.push(status); }
  if (mine) { where.push("created_by = ?"); args.push(mine); }
  const sql = "SELECT * FROM orch_jobs" + (where.length ? " WHERE " + where.join(" AND ") : "") + " ORDER BY created_at DESC";
  return db.prepare(sql).all(...args);
}

export function getJob(db, id) {
  const job = getJobRow(db, id);
  if (!job) return null;
  return {
    job,
    events: db.prepare("SELECT * FROM job_events WHERE job_id = ? ORDER BY seq").all(id),
    draft: db.prepare("SELECT * FROM job_draft WHERE job_id = ?").get(id) ?? null,
    actions: db.prepare("SELECT * FROM job_actions WHERE job_id = ? ORDER BY ordinal, id").all(id),
    decisions: db.prepare("SELECT * FROM decisions WHERE job_id = ? ORDER BY ts").all(id),
  };
}

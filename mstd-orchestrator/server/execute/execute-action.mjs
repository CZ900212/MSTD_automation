import { buildWriteArgs } from "../safety/write-args.mjs";
import { buildAgentAction } from "../safety/action-dsl.mjs";
import { markStatus } from "../safety/action-store.mjs";
import { assertTestTarget } from "./write-target.mjs";
import { canonicalDeliverableKey } from "../sessions/session-key.mjs";

export function loadApprovedHashes(db, jobId) {
  // 同一毫秒多条 approve（重试）时以 rowid 最新为准，不能随机取旧 hash
  const row = db.prepare(
    `SELECT approved_action_keys_json FROM decisions WHERE job_id = ? AND decision = 'approve' ORDER BY ts DESC, rowid DESC LIMIT 1`
  ).get(jobId);
  const map = new Map();
  if (!row || !row.approved_action_keys_json) return map;
  try {
    for (const e of JSON.parse(row.approved_action_keys_json)) {
      if (e && e.action_key) map.set(e.action_key, e.payload_hash);
    }
  } catch { /* 空 map = 无批准记录 */ }
  return map;
}

export async function executeApprovedAction(db, { actionId, approvedHash, runLark, testTarget, heartbeat = null, now = Date.now() }) {
  const action = db.prepare(`SELECT * FROM job_actions WHERE id = ?`).get(actionId);
  if (!action) return { ok: false, reason: "unknown action", status: "unknown" };
  if (action.status === "succeeded") return { ok: true, status: "succeeded" };

  const payload = JSON.parse(action.canonical_payload_json);

  // Task 4B：批准 hash 缺失即 fail-closed——禁止拿当前 row hash 冒充批准值
  if (approvedHash == null) {
    markStatus(db, action.id, "failed", JSON.stringify({ error: "not_approved", now }));
    return { ok: false, reason: "not_approved", status: "failed" };
  }
  if (action.payload_hash !== approvedHash) {
    markStatus(db, action.id, "failed", JSON.stringify({ error: "hash_mismatch", now }));
    return { ok: false, reason: "hash_mismatch", status: "failed" };
  }

  try {
    assertTestTarget({ kind: action.kind, payload }, testTarget);
  } catch (e) {
    markStatus(db, action.id, "failed", JSON.stringify({ error: String(e.message || e) }));
    return { ok: false, reason: "non_test_target", status: "failed" };
  }

  // schedule_reminder 是本地 DB 写：走专用 heartbeat adapter，不构造 lark argv
  if (action.kind === "schedule_reminder") {
    return executeScheduleReminder(db, { action, payload, heartbeat });
  }

  let argv;
  try {
    argv = buildWriteArgs({ kind: action.kind, payload }, action.idempotency_key);
  } catch (e) {
    markStatus(db, action.id, "failed", JSON.stringify({ error: String(e.message || e) }));
    return { ok: false, reason: "build_args_rejected", status: "failed" };
  }

  const dry = await runLark([...argv, "--dry-run"]);
  if (dry.exitCode !== 0) {
    markStatus(db, action.id, "failed", JSON.stringify({ error: "dry_run_failed", stderr: dry.stderr }));
    return { ok: false, reason: "dry_run_failed", status: "failed" };
  }

  markStatus(db, action.id, "executing");
  const res = await runLark(argv);
  if (res.exitCode === 0) {
    markStatus(db, action.id, "succeeded", JSON.stringify({ stdout: res.stdout }));
    return { ok: true, status: "succeeded" };
  }
  markStatus(db, action.id, "failed", JSON.stringify({ error: "exec_failed", exitCode: res.exitCode, stderr: res.stderr }));
  return { ok: false, reason: "exec_failed", status: "failed" };
}

// Task 4B：跨会话提醒的已确认执行——owner 取 job params 的 authoritative sessionKey（不信 payload），
// action-specific dry validation（canonical 重建同 hash）取代 lark --dry-run，幂等靠 source_action_id 唯一约束。
function executeScheduleReminder(db, { action, payload, heartbeat }) {
  if (!heartbeat || typeof heartbeat.addApproved !== "function") {
    markStatus(db, action.id, "failed", JSON.stringify({ error: "no_heartbeat_adapter" }));
    return { ok: false, reason: "no_heartbeat_adapter", status: "failed" };
  }
  const job = db.prepare(`SELECT params_json FROM orch_jobs WHERE id = ?`).get(action.job_id);
  let owner = null;
  try { owner = JSON.parse(job?.params_json ?? "{}").sessionKey ?? null; } catch { owner = null; }
  // owner 与 addOwned 同标准：仅 canonical feishu:p2p:*/feishu:group:*。cron/debug 发起的
  // job 即使过了确认卡也拒绝——否则落库的 owner 无人能 listOwned/removeOwned。
  owner = canonicalDeliverableKey(owner);
  if (!owner) {
    markStatus(db, action.id, "failed", JSON.stringify({ error: "no_owner_session" }));
    return { ok: false, reason: "no_owner_session", status: "failed" };
  }
  try {
    const rebuilt = buildAgentAction({ jobId: action.job_id, kind: action.kind, payload, ordinal: action.ordinal ?? 0 });
    if (rebuilt.payload_hash !== action.payload_hash) throw new Error("canonical 重建 hash 漂移");
  } catch (e) {
    markStatus(db, action.id, "failed", JSON.stringify({ error: "dry_validation_failed", detail: String(e.message || e) }));
    return { ok: false, reason: "dry_validation_failed", status: "failed" };
  }
  markStatus(db, action.id, "executing");
  const r = heartbeat.addApproved({
    ownerSessionKey: owner,
    deliverTo: payload.deliver_to,
    dueIso: payload.due_iso,
    text: payload.text,
    sourceActionId: action.id,
  });
  if (r.ok) {
    markStatus(db, action.id, "succeeded", JSON.stringify({ heartbeat_item_id: r.itemId, deduped: !!r.deduped }));
    return { ok: true, status: "succeeded" };
  }
  markStatus(db, action.id, "failed", JSON.stringify({ error: "heartbeat_add_failed", detail: r.error }));
  return { ok: false, reason: "heartbeat_add_failed", status: "failed" };
}

export async function reconcileAction(db, { action, runLark }) {
  // schedule_reminder 是本地 DB 写：指纹 = heartbeat_items.source_action_id，绝不打 lark
  if (action.kind === "schedule_reminder") {
    const hit = db.prepare("SELECT id FROM heartbeat_items WHERE source_action_id = ?").get(action.id);
    if (hit) {
      markStatus(db, action.id, "succeeded", JSON.stringify({ reconciled: true, heartbeat_item_id: hit.id }));
      return { reconciled: true };
    }
    return { reconciled: false };
  }
  const res = await runLark(["task", "+list", "--as", "user"]);
  let found = false;
  try {
    const parsed = JSON.parse(res.stdout || "{}");
    const items = Array.isArray(parsed.items) ? parsed.items : [];
    found = items.some((it) => it && it.idempotency_key === action.idempotency_key);
  } catch { found = false; }
  if (found) { markStatus(db, action.id, "succeeded", JSON.stringify({ reconciled: true })); return { reconciled: true }; }
  return { reconciled: false };
}

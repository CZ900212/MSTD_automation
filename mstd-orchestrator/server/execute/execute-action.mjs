import { buildWriteArgs } from "../safety/write-args.mjs";
import { buildAgentAction, validateStoredProvenance } from "../safety/action-dsl.mjs";
import { markStatus } from "../safety/action-store.mjs";
import { assertTestTarget } from "./write-target.mjs";
import { canonicalDeliverableKey } from "../sessions/session-key.mjs";

export function loadApprovedHashes(db, jobId) {
  // 同一毫秒多条 approve（重试）时以 rowid 最新为准，不能随机取旧 hash。
  const row = db.prepare(
    `SELECT approved_action_keys_json, provenance_hash_at_decision FROM decisions WHERE job_id = ? AND decision = 'approve' ORDER BY ts DESC, rowid DESC LIMIT 1`
  ).get(jobId);
  const map = new Map();
  if (!row || !row.approved_action_keys_json) return map;
  try {
    for (const e of JSON.parse(row.approved_action_keys_json)) {
      if (e && e.action_key) map.set(e.action_key, { payloadHash: e.payload_hash, provenanceHash: row.provenance_hash_at_decision ?? null });
    }
  } catch { /* 空 map = 无批准记录 */ }
  return map;
}

function validateTaskNotificationDependency(db, { action, payload }) {
  const source = db.prepare("SELECT * FROM job_actions WHERE job_id = ? AND action_key = ?")
    .get(action.job_id, payload.source_task_action_key);
  let sourcePayload = null;
  try { sourcePayload = source ? JSON.parse(source.canonical_payload_json) : null; } catch { sourcePayload = null; }
  return Boolean(source && source.kind === "create_task" && source.status === "succeeded"
    && sourcePayload?.assignee_open_id === payload.to_open_id);
}

export async function executeApprovedAction(db, { actionId, approvedHash, runLark, testTarget, heartbeat = null, now = Date.now() }) {
  const action = db.prepare(`SELECT * FROM job_actions WHERE id = ?`).get(actionId);
  if (!action) return { ok: false, reason: "unknown action", status: "unknown" };
  if (action.status === "succeeded") return { ok: true, status: "succeeded" };

  const payload = JSON.parse(action.canonical_payload_json);

  // Task 4B/D：批准 payload 或 decision-time provenance 缺失即 fail-closed。
  const approved = typeof approvedHash === "object" && approvedHash !== null
    ? approvedHash
    : { payloadHash: approvedHash, provenanceHash: null }; // 兼容直接 executor 测试的旧调用
  if (approved.payloadHash == null) {
    markStatus(db, action.id, "failed", JSON.stringify({ error: "not_approved", now }));
    return { ok: false, reason: "not_approved", status: "failed" };
  }
  if (action.payload_hash !== approved.payloadHash) {
    markStatus(db, action.id, "failed", JSON.stringify({ error: "hash_mismatch", now }));
    return { ok: false, reason: "hash_mismatch", status: "failed" };
  }
  if (action.provenance_hash !== approved.provenanceHash
    || !validateStoredProvenance({ manifestJson: action.provenance_manifest_json, provenanceHash: action.provenance_hash })) {
    markStatus(db, action.id, "failed", JSON.stringify({ error: "provenance_mismatch", now }));
    return { ok: false, reason: "provenance_mismatch", status: "failed" };
  }

  // 执行前从持久化 payload 重建 canonical hash，防止批准后只篡改 JSON 内容而保留 hash 列。
  if (action.kind !== "notify_task_assignee") {
    try {
      const rebuilt = buildAgentAction({ jobId: action.job_id, kind: action.kind, payload, ordinal: action.ordinal ?? 0 });
      if (rebuilt.payload_hash !== action.payload_hash) throw new Error("canonical 重建 hash 漂移");
    } catch (e) {
      markStatus(db, action.id, "failed", JSON.stringify({ error: "dry_validation_failed", detail: String(e.message || e) }));
      return { ok: false, reason: "dry_validation_failed", status: "failed" };
    }
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

  if (action.kind === "notify_task_assignee" && !validateTaskNotificationDependency(db, { action, payload })) {
    markStatus(db, action.id, "failed", JSON.stringify({ error: "dependency_not_succeeded" }));
    return { ok: false, reason: "dependency_not_succeeded", status: "failed" };
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
  // create_event 无 CLI 幂等键（calendar +create 不支持 --idempotency-key，真机确认）：
  // 超时 SIGTERM/网络断连时事件可能已在飞书侧落地，盲标 failed 会弹重试按钮重复建日程。
  // 失败即回查指纹（summary+start+end），命中则视为成功。
  if (action.kind === "create_event") {
    try {
      const r = await reconcileAction(db, { action, runLark });
      if (r.reconciled) return { ok: true, status: "succeeded" };
    } catch { /* 回查失败按未落地处理 */ }
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

export function isTaskCompleteResponse(stdout, expectedGuid) {
  try {
    const parsed = JSON.parse(stdout || "{}");
    const task = parsed?.data?.task;
    return parsed?.ok === true
      && task?.guid === expectedGuid
      && task?.status === "done"
      && task?.agent_task_status === 4
      && typeof task?.completed_at === "string"
      && task.completed_at !== "0";
  } catch {
    return false;
  }
}

function eventTimeToEpochMs(v) {
  // 兼容 CLI/API 两种时间形状：{timestamp:"秒"} 对象、epoch 字符串、ISO 字符串
  if (v == null) return null;
  if (typeof v === "object") v = v.timestamp ?? v.date ?? null;
  if (v == null) return null;
  const s = String(v);
  if (/^\d+$/.test(s)) return s.length > 10 ? Number(s) : Number(s) * 1000;
  const t = Date.parse(s);
  return Number.isNaN(t) ? null : t;
}

// create_event 对账指纹：summary 精确相等 + start/end epoch 相等（CLI 无幂等键，这是唯一可用指纹）
export function isEventCreatedResponse(stdout, payload) {
  try {
    const parsed = JSON.parse(stdout || "{}");
    const items = Array.isArray(parsed.items) ? parsed.items
      : Array.isArray(parsed.data?.items) ? parsed.data.items : [];
    const wantStart = Date.parse(payload.start_time);
    const wantEnd = Date.parse(payload.end_time);
    if (Number.isNaN(wantStart) || Number.isNaN(wantEnd)) return false;
    return items.some((it) => it
      && String(it.summary ?? "") === payload.summary
      && eventTimeToEpochMs(it.start_time) === wantStart
      && eventTimeToEpochMs(it.end_time) === wantEnd);
  } catch {
    return false;
  }
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
  if (action.kind === "complete_task") {
    let payload;
    try { payload = JSON.parse(action.canonical_payload_json); } catch { return { reconciled: false }; }
    const taskGuid = payload?.task_guid;
    if (typeof taskGuid !== "string" || !taskGuid) return { reconciled: false };
    const res = await runLark(["task", "tasks", "get", "--task-guid", taskGuid, "--as", "user"]);
    if (res.exitCode === 0 && isTaskCompleteResponse(res.stdout, taskGuid)) {
      markStatus(db, action.id, "succeeded", JSON.stringify({ reconciled: true, task_guid: taskGuid }));
      return { reconciled: true };
    }
    return { reconciled: false };
  }
  if (action.kind === "create_event") {
    let payload;
    try { payload = JSON.parse(action.canonical_payload_json); } catch { return { reconciled: false, unsupported: true }; }
    if (typeof payload?.summary !== "string" || !payload.summary.trim()) return { reconciled: false, unsupported: true };
    const res = await runLark(["calendar", "+search-event", "--as", "user",
      "--query", payload.summary, "--start", payload.start_time, "--end", payload.end_time, "--json"]);
    if (res.exitCode === 0 && isEventCreatedResponse(res.stdout, payload)) {
      markStatus(db, action.id, "succeeded", JSON.stringify({ reconciled: true, fingerprint: "summary+start+end" }));
      return { reconciled: true };
    }
    return { reconciled: false };
  }
  if (action.kind !== "create_task") {
    return { reconciled: false, unsupported: true };
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

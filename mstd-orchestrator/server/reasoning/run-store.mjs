// Durable task executions and run-scoped closure state.
import { randomUUID } from "node:crypto";

const RUN_STATUSES = new Set([
  "queued", "running", "closing", "completed", "failed", "interrupted", "cancelled",
]);
const OPEN_RUN_STATUSES = new Set(["queued", "running", "closing"]);
const CLOSURE_MODES = new Set(["required", "silent_ok"]);
const DISPATCH_RELATIONS = new Set(["origin", "attach", "tool_result", "reinject"]);

export function terminalIdempotencyKey(runId) {
  if (!runId) throw new Error("terminalIdempotencyKey: runId 必填");
  return `run:${runId}:terminal`;
}

export function createReasoningRunStore(db, { now = Date.now } = {}) {
  if (!db) throw new Error("createReasoningRunStore: db 必填");

  const getRunStmt = db.prepare(`SELECT * FROM reasoning_runs WHERE id = ?`);
  const getTask = db.prepare(`SELECT * FROM reasoning_tasks WHERE id = ?`);
  const getDispatch = db.prepare(`SELECT * FROM reasoning_dispatches WHERE id = ?`);
  const currentOpen = db.prepare(`
    SELECT * FROM reasoning_runs
    WHERE task_id = ? AND status IN ('queued', 'running', 'closing')
    ORDER BY created_at ASC LIMIT 1
  `);
  const insertRun = db.prepare(`
    INSERT INTO reasoning_runs (
      id, task_id, origin_dispatch_id, parent_run_id, origin_kind, origin_id, brief,
      status, closure_mode, closure_state, turn_id, resident_key,
      terminal_idempotency_key, terminal_message_id, failure_summary,
      created_at, updated_at, started_at, completed_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, 'queued', ?, 'open', NULL, NULL, ?, NULL, NULL, ?, ?, NULL, NULL)
  `);
  const linkDispatch = db.prepare(`
    INSERT OR IGNORE INTO reasoning_run_dispatches (run_id, dispatch_id, relation, created_at)
    VALUES (?, ?, ?, ?)
  `);
  const listRunDispatches = db.prepare(`
    SELECT * FROM reasoning_run_dispatches WHERE run_id = ? ORDER BY created_at ASC, rowid ASC
  `);
  const startQueued = db.prepare(`
    UPDATE reasoning_runs
    SET status = 'running', turn_id = ?, resident_key = ?, started_at = ?, updated_at = ?
    WHERE id = ? AND status = 'queued' AND closure_state = 'open'
  `);
  const upgradeRunClosure = db.prepare(`
    UPDATE reasoning_runs
    SET closure_mode = CASE
          WHEN closure_mode = 'required' OR ? = 'required' THEN 'required'
          ELSE 'silent_ok'
        END,
        updated_at = ?
    WHERE id = ? AND status IN ('queued', 'running', 'closing')
  `);
  const claimRequiredClosure = db.prepare(`
    UPDATE reasoning_runs
    SET status = 'closing', closure_state = 'pending_send', updated_at = ?
    WHERE id = ?
      AND status IN ('queued', 'running')
      AND closure_mode = 'required'
      AND closure_state = 'open'
  `);
  const recordSent = db.prepare(`
    UPDATE reasoning_runs
    SET status = 'completed', closure_state = ?, terminal_message_id = ?,
        failure_summary = COALESCE(?, failure_summary), updated_at = ?, completed_at = ?
    WHERE id = ? AND status = 'closing' AND closure_state = 'pending_send'
  `);
  const closeSilentStmt = db.prepare(`
    UPDATE reasoning_runs
    SET status = 'completed', closure_state = 'silent_closed', updated_at = ?, completed_at = ?
    WHERE id = ?
      AND status IN ('queued', 'running')
      AND closure_mode = 'silent_ok'
      AND closure_state = 'open'
  `);
  const interruptStmt = db.prepare(`
    UPDATE reasoning_runs
    SET status = 'interrupted', failure_summary = ?, updated_at = ?, completed_at = ?
    WHERE id = ? AND status IN ('queued', 'running', 'closing')
  `);
  const listRecoverable = db.prepare(`
    SELECT r.*, t.session_id, t.status AS task_status
    FROM reasoning_runs r
    JOIN reasoning_tasks t ON t.id = r.task_id
    WHERE r.status IN ('queued', 'running', 'closing')
    ORDER BY r.created_at ASC, r.rowid ASC
    LIMIT ?
  `);
  const getInputByOrigin = db.prepare(`
    SELECT * FROM reasoning_run_inputs WHERE origin_kind = ? AND origin_id = ?
  `);
  const insertInput = db.prepare(`
    INSERT INTO reasoning_run_inputs (
      id, run_id, task_id, parent_run_id, origin_kind, origin_id, dispatch_id,
      session_version, status, brief, context_envelope_json, created_at, delivered_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?, NULL)
  `);
  const listPendingInputs = db.prepare(`
    SELECT * FROM reasoning_run_inputs
    WHERE run_id = ? AND status = 'pending'
    ORDER BY created_at ASC, id ASC
  `);
  const markInputDeliveredStmt = db.prepare(`
    UPDATE reasoning_run_inputs
    SET status = 'delivered', delivered_at = ?
    WHERE id = ? AND status = 'pending'
  `);
  const movePendingInputStmt = db.prepare(`
    UPDATE reasoning_run_inputs SET run_id = ? WHERE id = ? AND status = 'pending'
  `);

  function getRun(runId) {
    if (!runId) return null;
    return getRunStmt.get(runId) ?? null;
  }

  function assertTaskActive(taskId) {
    const task = getTask.get(taskId);
    if (!task) throw new Error("createRun: task 不存在");
    if (task.status !== "active") throw new Error(`createRun: task 必须是 active，当前 ${task.status}`);
    return task;
  }

  function validateDispatchForTask(task, dispatchId, operation) {
    if (!dispatchId) return null;
    const dispatch = getDispatch.get(dispatchId);
    if (!dispatch) throw new Error(`${operation}: dispatch 不存在`);
    if (dispatch.session_id !== task.session_id) throw new Error(`${operation}: dispatch 跨会话`);
    return dispatch;
  }

  const createRunTx = db.transaction(({
    taskId,
    originDispatchId = null,
    parentRunId = null,
    originKind,
    originId = null,
    closureMode = "silent_ok",
    brief = "",
    id = null,
  } = {}) => {
    if (!taskId) throw new Error("createRun: taskId 必填");
    if (!originKind?.trim()) throw new Error("createRun: originKind 必填");
    if (!CLOSURE_MODES.has(closureMode)) throw new Error("createRun: closureMode 非法");
    const task = assertTaskActive(taskId);
    validateDispatchForTask(task, originDispatchId, "createRun");
    if (parentRunId) {
      const parent = getRunStmt.get(parentRunId);
      if (!parent) throw new Error("createRun: 父 run 不存在");
      if (parent.task_id !== taskId) throw new Error("createRun: parent run 必须属于同一 task");
    }
    if (currentOpen.get(taskId)) throw new Error("createRun: task 已有进行中的 open run");

    const runId = id ?? randomUUID();
    const ts = now();
    try {
      insertRun.run(
        runId,
        taskId,
        originDispatchId,
        parentRunId,
        originKind.trim(),
        originId == null ? null : String(originId),
        String(brief ?? ""),
        closureMode,
        terminalIdempotencyKey(runId),
        ts,
        ts,
      );
    } catch (error) {
      if (currentOpen.get(taskId)) throw new Error("createRun: task 已有进行中的 open run", { cause: error });
      throw error;
    }
    if (originDispatchId) linkDispatch.run(runId, originDispatchId, "origin", ts);
    return getRunStmt.get(runId);
  });

  function createRun(options) {
    return createRunTx.immediate(options);
  }

  function currentOpenRun(taskId) {
    if (!taskId) throw new Error("currentOpenRun: taskId 必填");
    return currentOpen.get(taskId) ?? null;
  }

  function startRun(runId, { turnId, residentKey } = {}) {
    if (!runId || !turnId || !residentKey) throw new Error("startRun: runId/turnId/residentKey 必填");
    const row = getRun(runId);
    if (!row) throw new Error("startRun: run 不存在");
    if (row.status === "running" && row.turn_id === turnId && row.resident_key === residentKey) return row;
    if (row.status !== "queued") throw new Error(`startRun: 非法状态 ${row.status}`);
    const ts = now();
    if (!startQueued.run(turnId, residentKey, ts, ts, runId).changes) throw new Error("startRun: 状态竞争失败");
    return getRun(runId);
  }

  const attachDispatchTx = db.transaction((runId, dispatchId, { relation = "attach" } = {}) => {
    if (!runId || !dispatchId) throw new Error("attachDispatch: runId/dispatchId 必填");
    if (!DISPATCH_RELATIONS.has(relation)) throw new Error("attachDispatch: relation 非法");
    const run = getRunStmt.get(runId);
    if (!run) throw new Error("attachDispatch: run 不存在");
    if (!OPEN_RUN_STATUSES.has(run.status)) throw new Error("attachDispatch: run 已终态");
    const task = getTask.get(run.task_id);
    validateDispatchForTask(task, dispatchId, "attachDispatch");
    return linkDispatch.run(runId, dispatchId, relation, now()).changes > 0;
  });

  function attachDispatch(runId, dispatchId, options) {
    return attachDispatchTx.immediate(runId, dispatchId, options);
  }

  function listDispatches(runId) {
    if (!getRun(runId)) throw new Error("listDispatches: run 不存在");
    return listRunDispatches.all(runId);
  }

  function upgradeClosure(runId, closureMode = "silent_ok") {
    if (!CLOSURE_MODES.has(closureMode)) throw new Error("upgradeClosure: closureMode 非法");
    const row = getRun(runId);
    if (!row) throw new Error("upgradeClosure: run 不存在");
    if (!OPEN_RUN_STATUSES.has(row.status)) throw new Error("upgradeClosure: run 已终态");
    if (!upgradeRunClosure.run(closureMode, now(), runId).changes) throw new Error("upgradeClosure: 状态竞争失败");
    return getRun(runId);
  }

  function claimClosure(runId) {
    const row = getRun(runId);
    if (!row) throw new Error("claimClosure: run 不存在");
    if (row.status === "closing" && row.closure_state === "pending_send") return row;
    if (row.closure_mode !== "required") throw new Error("claimClosure: silent_ok run 不需要发送闭合");
    if (!claimRequiredClosure.run(now(), runId).changes) throw new Error(`claimClosure: 非法状态 ${row.status}/${row.closure_state}`);
    return getRun(runId);
  }

  function recordTerminal(runId, { messageId, safeFallback = false, failureSummary = null } = {}) {
    if (!messageId) throw new Error("recordTerminal: messageId 必填");
    const row = getRun(runId);
    if (!row) throw new Error("recordTerminal: run 不存在");
    if (row.status === "completed" && ["sent", "safe_fallback_sent"].includes(row.closure_state)) {
      if (row.terminal_message_id !== messageId) throw new Error("recordTerminal: terminal 消息已由其他 receipt 占用");
      if ((row.closure_state === "safe_fallback_sent") !== Boolean(safeFallback)) {
        throw new Error("recordTerminal: terminal 类型不匹配");
      }
      return row;
    }
    const ts = now();
    const state = safeFallback ? "safe_fallback_sent" : "sent";
    if (!recordSent.run(state, messageId, failureSummary, ts, ts, runId).changes) {
      throw new Error(`recordTerminal: 非法状态 ${row.status}/${row.closure_state}`);
    }
    return getRun(runId);
  }

  function closeSilent(runId) {
    const row = getRun(runId);
    if (!row) throw new Error("closeSilent: run 不存在");
    if (row.status === "completed" && row.closure_state === "silent_closed") return row;
    const ts = now();
    if (!closeSilentStmt.run(ts, ts, runId).changes) {
      throw new Error(`closeSilent: 非法状态 ${row.status}/${row.closure_mode}/${row.closure_state}`);
    }
    return getRun(runId);
  }

  function markInterrupted(runId, { failureSummary = null } = {}) {
    const row = getRun(runId);
    if (!row) throw new Error("markInterrupted: run 不存在");
    if (row.status === "interrupted") return row;
    const ts = now();
    if (!interruptStmt.run(failureSummary == null ? null : String(failureSummary).slice(0, 500), ts, ts, runId).changes) {
      throw new Error(`markInterrupted: 非法状态 ${row.status}`);
    }
    return getRun(runId);
  }

  function listRecoverableRuns({ limit = 100 } = {}) {
    if (!Number.isSafeInteger(limit) || limit < 1) throw new Error("listRecoverableRuns: limit 非法");
    return listRecoverable.all(limit);
  }

  const attachInputTx = db.transaction(({
    runId,
    taskId,
    parentRunId = null,
    originKind,
    originId,
    dispatchId = null,
    sessionVersion,
    brief,
    contextEnvelope = null,
    id = null,
  } = {}) => {
    if (!runId || !taskId || !originKind?.trim() || !originId) {
      throw new Error("attachInput: runId/taskId/originKind/originId 必填");
    }
    if (!Number.isSafeInteger(sessionVersion) || sessionVersion < 0) {
      throw new Error("attachInput: sessionVersion 非法");
    }
    const existing = getInputByOrigin.get(originKind, String(originId));
    if (existing) {
      if (existing.run_id !== runId || existing.task_id !== taskId || existing.parent_run_id !== parentRunId) {
        throw new Error("attachInput: origin 已绑定其他 run");
      }
      return existing;
    }
    const run = getRunStmt.get(runId);
    if (!run || run.task_id !== taskId || !OPEN_RUN_STATUSES.has(run.status)) {
      throw new Error("attachInput: run 非 open 或 task 不匹配");
    }
    if (parentRunId) {
      const parent = getRunStmt.get(parentRunId);
      if (!parent || parent.task_id !== taskId) throw new Error("attachInput: parent run 不匹配");
    }
    const ts = now();
    insertInput.run(
      id ?? randomUUID(),
      runId,
      taskId,
      parentRunId,
      originKind.trim(),
      String(originId),
      dispatchId == null ? null : String(dispatchId),
      sessionVersion,
      String(brief ?? ""),
      contextEnvelope == null ? null : JSON.stringify(contextEnvelope),
      ts,
    );
    return getInputByOrigin.get(originKind, String(originId));
  });

  function attachInput(options) {
    return attachInputTx.immediate(options);
  }

  function pendingInputs(runId) {
    if (!getRun(runId)) throw new Error("pendingInputs: run 不存在");
    return listPendingInputs.all(runId);
  }

  function movePendingInput(inputId, runId) {
    if (!inputId || !runId) throw new Error("movePendingInput: inputId/runId 必填");
    const input = db.prepare("SELECT * FROM reasoning_run_inputs WHERE id = ?").get(inputId);
    const run = getRun(runId);
    if (!input || !run || input.task_id !== run.task_id || !OPEN_RUN_STATUSES.has(run.status)) {
      throw new Error("movePendingInput: input/run 不匹配");
    }
    if (input.status !== "pending") throw new Error("movePendingInput: input 已交付");
    if (!movePendingInputStmt.run(runId, inputId).changes) throw new Error("movePendingInput: 状态竞争失败");
    return db.prepare("SELECT * FROM reasoning_run_inputs WHERE id = ?").get(inputId);
  }

  function markInputDelivered(inputId) {
    if (!inputId) throw new Error("markInputDelivered: inputId 必填");
    const row = db.prepare("SELECT * FROM reasoning_run_inputs WHERE id = ?").get(inputId);
    if (!row) throw new Error("markInputDelivered: input 不存在");
    if (row.status === "delivered") return row;
    if (!markInputDeliveredStmt.run(now(), inputId).changes) throw new Error("markInputDelivered: 状态竞争失败");
    return db.prepare("SELECT * FROM reasoning_run_inputs WHERE id = ?").get(inputId);
  }

  return {
    createRun,
    getRun,
    currentOpenRun,
    startRun,
    attachDispatch,
    listDispatches,
    upgradeClosure,
    claimClosure,
    recordTerminal,
    closeSilent,
    markInterrupted,
    listRecoverableRuns,
    attachInput,
    pendingInputs,
    movePendingInput,
    markInputDelivered,
    RUN_STATUSES,
    OPEN_RUN_STATUSES,
  };
}

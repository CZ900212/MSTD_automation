// Durable reasoning tasks + dispatcher outbox (pending_send → pending_review → running → done/failed).
import { createHash, randomUUID } from "node:crypto";

const TASK_STATUSES = new Set(["active", "completed", "failed", "cancelled"]);
const DISPATCH_STATUSES = new Set(["pending_send", "pending_review", "running", "done", "failed"]);
const RELATIONS = new Set(["source", "steer", "tool_result", "handoff", "closure"]);

function stableBatchKey(sourceMessageIds) {
  const ids = [...sourceMessageIds].map(String).sort();
  return createHash("sha256").update(ids.join("\0")).digest("hex");
}

export function outboundIdempotencyKey({ sessionId, sourceBatchKey, responderText }) {
  return createHash("sha256")
    .update([sessionId, sourceBatchKey, String(responderText ?? "")].join("\0"))
    .digest("hex");
}

export function createReasoningTaskStore(db, { now = Date.now } = {}) {
  if (!db) throw new Error("createReasoningTaskStore: db 必填");

  const insertTask = db.prepare(`
    INSERT INTO reasoning_tasks
      (id, session_id, title, summary, status, closure_mode, created_at, updated_at, completed_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL)
  `);
  const getTask = db.prepare(`SELECT * FROM reasoning_tasks WHERE id = ?`);
  const listActive = db.prepare(`
    SELECT * FROM reasoning_tasks
    WHERE session_id = ? AND status = 'active'
    ORDER BY updated_at DESC
    LIMIT ?
  `);
  const updateTask = db.prepare(`
    UPDATE reasoning_tasks
    SET status = COALESCE(?, status),
        summary = COALESCE(?, summary),
        title = COALESCE(?, title),
        updated_at = ?,
        completed_at = CASE
          WHEN ? IN ('completed', 'failed', 'cancelled') THEN ?
          ELSE completed_at
        END
    WHERE id = ?
  `);
  const mergeTaskClosure = db.prepare(`
    UPDATE reasoning_tasks
    SET closure_mode = CASE
          WHEN closure_mode = 'required' OR ? = 'required' THEN 'required'
          ELSE 'silent_ok'
        END,
        updated_at = ?
    WHERE id = ?
  `);
  const linkMsg = db.prepare(`
    INSERT OR IGNORE INTO reasoning_task_messages (task_id, message_id, relation, created_at)
    VALUES (?, ?, ?, ?)
  `);
  const listTaskMessages = db.prepare(`
    SELECT m.*, l.relation AS link_relation
    FROM reasoning_task_messages l
    JOIN agent_messages m ON m.id = l.message_id
    WHERE l.task_id = ?
    ORDER BY m.ts ASC, m.id ASC
  `);
  const sessionOfMessage = db.prepare(`SELECT session_id FROM agent_messages WHERE id = ?`);
  const sessionOfTask = db.prepare(`SELECT session_id FROM reasoning_tasks WHERE id = ?`);

  const insertDispatch = db.prepare(`
    INSERT INTO reasoning_dispatches (
      id, session_id, source_message_ids_json, source_batch_key,
      responder_message_id, responder_action, responder_text, outbound_idempotency_key,
      mode, status, verdict_json, attempts, created_at, updated_at
    ) VALUES (?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, NULL, 0, ?, ?)
  `);
  const getDispatch = db.prepare(`SELECT * FROM reasoning_dispatches WHERE id = ?`);
  const getDispatchByBatch = db.prepare(`
    SELECT * FROM reasoning_dispatches WHERE session_id = ? AND source_batch_key = ?
  `);
  const getDispatchByOutbound = db.prepare(`
    SELECT * FROM reasoning_dispatches WHERE outbound_idempotency_key = ?
  `);
  const getMessage = db.prepare(`SELECT * FROM agent_messages WHERE id = ?`);
  const getAssistantByPlatformId = db.prepare(`
    SELECT * FROM agent_messages
    WHERE session_id = ? AND role = 'assistant' AND platform_message_id = ?
    ORDER BY rowid DESC LIMIT 1
  `);
  const markPendingReview = db.prepare(`
    UPDATE reasoning_dispatches
    SET status = 'pending_review',
        responder_message_id = ?,
        updated_at = ?
    WHERE id = ? AND status = 'pending_send'
  `);
  const claimReview = db.prepare(`
    UPDATE reasoning_dispatches
    SET status = 'running',
        attempts = attempts + 1,
        updated_at = ?
    WHERE id = ? AND status = 'pending_review'
  `);
  const finishDispatch = db.prepare(`
    UPDATE reasoning_dispatches
    SET status = ?,
        verdict_json = COALESCE(?, verdict_json),
        updated_at = ?
    WHERE id = ? AND status = 'running'
  `);
  const releaseStaleRunning = db.prepare(`
    UPDATE reasoning_dispatches
    SET status = 'pending_review',
        updated_at = ?
    WHERE status = 'running' AND updated_at < ?
  `);
  const listPendingSend = db.prepare(`
    SELECT * FROM reasoning_dispatches WHERE status = 'pending_send' ORDER BY created_at ASC LIMIT ?
  `);
  const listPendingReview = db.prepare(`
    SELECT * FROM reasoning_dispatches WHERE status = 'pending_review' ORDER BY created_at ASC LIMIT ?
  `);

  function createTask({ sessionId, title, summary = "", closureMode = "silent_ok", id = null } = {}) {
    if (!sessionId) throw new Error("createTask: sessionId 必填");
    if (!title?.trim()) throw new Error("createTask: title 必填");
    if (!["required", "silent_ok"].includes(closureMode)) throw new Error("createTask: closureMode 非法");
    const taskId = id ?? randomUUID();
    const ts = now();
    insertTask.run(taskId, sessionId, title.trim().slice(0, 120), String(summary ?? ""), "active", closureMode, ts, ts);
    return getTask.get(taskId);
  }

  function attachMessage({ taskId, messageId, relation = "source" } = {}) {
    if (!taskId || !messageId) throw new Error("attachMessage: taskId/messageId 必填");
    if (!RELATIONS.has(relation)) throw new Error(`attachMessage: relation 非法: ${relation}`);
    const task = sessionOfTask.get(taskId);
    if (!task) throw new Error("attachMessage: task 不存在");
    const msg = sessionOfMessage.get(messageId);
    if (!msg) throw new Error("attachMessage: message 不存在");
    if (msg.session_id !== task.session_id) {
      throw new Error("attachMessage: 跨会话拒绝");
    }
    linkMsg.run(taskId, messageId, relation, now());
    updateTask.run(null, null, null, now(), null, null, taskId);
    return true;
  }

  function transitionTask(taskId, { status, summary = null, title = null } = {}) {
    if (!taskId) throw new Error("transitionTask: taskId 必填");
    if (status && !TASK_STATUSES.has(status)) throw new Error(`transitionTask: status 非法: ${status}`);
    const ts = now();
    const r = updateTask.run(status ?? null, summary, title, ts, status ?? null, ts, taskId);
    if (!r.changes) throw new Error("transitionTask: task 不存在");
    return getTask.get(taskId);
  }

  // Closure is monotonic for an active task: once any attached turn promises a
  // follow-up, later silent_ok reviews must not erase that obligation.
  function mergeClosureMode(taskId, closureMode = "silent_ok") {
    if (!taskId) throw new Error("mergeClosureMode: taskId 必填");
    if (!["required", "silent_ok"].includes(closureMode)) {
      throw new Error("mergeClosureMode: closureMode 非法");
    }
    const r = mergeTaskClosure.run(closureMode, now(), taskId);
    if (!r.changes) throw new Error("mergeClosureMode: task 不存在");
    return getTask.get(taskId);
  }

  function activeSummaries(sessionId, { limit = 8, maxBytes = 2048 } = {}) {
    const rows = listActive.all(sessionId, limit);
    const out = [];
    let bytes = 0;
    for (const row of rows) {
      const item = {
        id: row.id,
        title: row.title,
        summary: row.summary,
        status: row.status,
        closure_mode: row.closure_mode,
      };
      const size = Buffer.byteLength(JSON.stringify(item), "utf8");
      if (out.length > 0 && bytes + size > maxBytes) break;
      out.push(item);
      bytes += size;
    }
    return out;
  }

  function listMessages(taskId) {
    return listTaskMessages.all(taskId);
  }

  function dispatchSourceItems(dispatchId) {
    const dispatch = getDispatch.get(dispatchId);
    if (!dispatch) throw new Error("dispatchSourceItems: dispatch 不存在");
    const ids = JSON.parse(dispatch.source_message_ids_json ?? "[]");
    return ids.map((id) => {
      const row = getMessage.get(id);
      if (!row || row.session_id !== dispatch.session_id || row.role !== "user") {
        throw new Error("dispatchSourceItems: source message 缺失、跨会话或角色非法");
      }
      return {
        content: row.content,
        senderOpenId: row.sender_open_id,
        senderName: row.sender_name,
        platformMessageId: row.platform_message_id,
        ts: row.ts,
      };
    });
  }

  /**
   * Create a durable dispatch before physical send (reply) or directly for review (no_reply).
   * Idempotent on (sessionId, source message batch).
   */
  function createDispatch({
    sessionId,
    sourceMessageIds,
    responderAction,
    responderText = null,
    mode = "p2p",
    id = null,
  } = {}) {
    if (!sessionId) throw new Error("createDispatch: sessionId 必填");
    if (!Array.isArray(sourceMessageIds) || sourceMessageIds.length === 0) {
      throw new Error("createDispatch: sourceMessageIds 必填");
    }
    if (!["reply", "no_reply"].includes(responderAction)) {
      throw new Error("createDispatch: responderAction 非法");
    }
    const batchKey = stableBatchKey(sourceMessageIds);
    const existing = getDispatchByBatch.get(sessionId, batchKey);
    if (existing) return existing;

    const ts = now();
    const dispatchId = id ?? randomUUID();
    let text = null;
    let outboundKey = null;
    let status;
    if (responderAction === "reply") {
      if (typeof responderText !== "string" || !responderText.trim()) {
        throw new Error("createDispatch: reply 需要 responderText");
      }
      text = responderText;
      outboundKey = outboundIdempotencyKey({ sessionId, sourceBatchKey: batchKey, responderText: text });
      status = "pending_send";
    } else {
      if (responderText != null) throw new Error("createDispatch: no_reply 禁止 responderText");
      status = "pending_review";
    }

    try {
      insertDispatch.run(
        dispatchId,
        sessionId,
        JSON.stringify([...sourceMessageIds].map(String)),
        batchKey,
        responderAction,
        text,
        outboundKey,
        mode,
        status,
        ts,
        ts,
      );
    } catch (e) {
      // Unique race: return the winner.
      const again = getDispatchByBatch.get(sessionId, batchKey);
      if (again) return again;
      throw e;
    }
    return getDispatch.get(dispatchId);
  }

  /** After physical send succeeds: record assistant message id and advance to pending_review. */
  function markDispatchSent(dispatchId, responderMessageId) {
    if (!dispatchId || !responderMessageId) throw new Error("markDispatchSent: 参数必填");
    const row = getDispatch.get(dispatchId);
    if (!row) throw new Error("markDispatchSent: dispatch 不存在");
    if (row.status === "pending_review" && row.responder_message_id === responderMessageId) {
      return getDispatch.get(dispatchId);
    }
    if (row.status !== "pending_send") {
      throw new Error(`markDispatchSent: 非法状态 ${row.status}`);
    }
    const r = markPendingReview.run(responderMessageId, now(), dispatchId);
    if (!r.changes) throw new Error("markDispatchSent: 状态竞争失败");
    return getDispatch.get(dispatchId);
  }

  const recordDispatchSentTx = db.transaction((dispatchId, {
    platformMessageId = null,
    appendAssistant,
  } = {}) => {
    const row = getDispatch.get(dispatchId);
    if (!row) throw new Error("recordDispatchSent: dispatch 不存在");
    if (row.responder_action !== "reply") throw new Error("recordDispatchSent: 仅 reply dispatch 可记录发送");
    if (typeof appendAssistant !== "function") throw new Error("recordDispatchSent: appendAssistant 必填");

    let assistant = row.responder_message_id ? getMessage.get(row.responder_message_id) : null;
    if (!assistant && platformMessageId != null) {
      assistant = getAssistantByPlatformId.get(row.session_id, platformMessageId) ?? null;
    }
    if (row.status === "pending_review") {
      if (!assistant) throw new Error("recordDispatchSent: pending_review 缺少 responder message");
      return { dispatch: row, assistant };
    }
    if (row.status !== "pending_send") {
      throw new Error(`recordDispatchSent: 非法状态 ${row.status}`);
    }

    if (!assistant) assistant = appendAssistant();
    const assistantId = assistant?.id;
    const assistantSessionId = assistant?.session_id ?? assistant?.sessionId;
    if (!assistantId || assistantSessionId !== row.session_id || assistant.role !== "assistant") {
      throw new Error("recordDispatchSent: responder message 非法或跨会话");
    }
    if (assistant.content !== row.responder_text) {
      throw new Error("recordDispatchSent: responder message 文本不匹配");
    }
    const updated = markPendingReview.run(assistantId, now(), dispatchId);
    if (!updated.changes) throw new Error("recordDispatchSent: 状态竞争失败");
    return { dispatch: getDispatch.get(dispatchId), assistant };
  });

  function recordDispatchSent(dispatchId, options) {
    return recordDispatchSentTx.immediate(dispatchId, options);
  }

  /** Dispatcher pump: claim only pending_review (never pending_send). */
  function claimDispatchForReview(dispatchId) {
    const row = getDispatch.get(dispatchId);
    if (!row) throw new Error("claimDispatchForReview: 不存在");
    if (row.status === "pending_send") {
      throw new Error("claimDispatchForReview: pending_send 不可 claim");
    }
    if (row.status === "running") return row;
    if (row.status !== "pending_review") {
      throw new Error(`claimDispatchForReview: 非法状态 ${row.status}`);
    }
    const r = claimReview.run(now(), dispatchId);
    if (!r.changes) throw new Error("claimDispatchForReview: 状态竞争失败");
    return getDispatch.get(dispatchId);
  }

  function completeDispatch(dispatchId, { status = "done", verdict = null } = {}) {
    if (!["done", "failed"].includes(status)) throw new Error("completeDispatch: status 非法");
    const row = getDispatch.get(dispatchId);
    if (!row) throw new Error("completeDispatch: 不存在");
    if (row.status === status) return row;
    if (row.status !== "running") throw new Error(`completeDispatch: 非法状态 ${row.status}`);
    finishDispatch.run(status, verdict == null ? null : JSON.stringify(verdict), now(), dispatchId);
    return getDispatch.get(dispatchId);
  }

  function recoverStaleRunning({ olderThanMs = 5 * 60_000 } = {}) {
    const cutoff = now() - olderThanMs;
    return releaseStaleRunning.run(now(), cutoff).changes;
  }

  function listRetryableSends({ limit = 50 } = {}) {
    return listPendingSend.all(limit);
  }

  function listReviewQueue({ limit = 50 } = {}) {
    return listPendingReview.all(limit);
  }

  return {
    createTask,
    attachMessage,
    transitionTask,
    mergeClosureMode,
    activeSummaries,
    listMessages,
    dispatchSourceItems,
    getTask: (id) => getTask.get(id),
    createDispatch,
    markDispatchSent,
    recordDispatchSent,
    claimDispatchForReview,
    completeDispatch,
    recoverStaleRunning,
    listRetryableSends,
    listReviewQueue,
    getDispatch: (id) => getDispatch.get(id),
    getDispatchByOutboundKey: (key) => getDispatchByOutbound.get(key),
    stableBatchKey,
    outboundIdempotencyKey,
    DISPATCH_STATUSES,
    TASK_STATUSES,
  };
}

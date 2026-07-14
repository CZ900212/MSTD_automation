// Post-response coordinator: claim pending_review dispatches, call dispatcher, spawn/attach tasks.
import { createDispatcher } from "../models/dispatcher.mjs";

const REQUIRED_CLOSURE_FALLBACK = "这次处理没能生成可安全发送的正式答复，请稍后重试。";

/**
 * @param {{
 *   taskStore: ReturnType<import("./task-store.mjs").createReasoningTaskStore>,
 *   dispatcher?: { review: Function },
 *   caller?: { call: Function },
 *   brain: { turn: Function, steer: Function, isBusy: Function },
 *   store?: { promptRecent?: Function },
 *   snapshotFn?: Function|null,
 *   activeBrainTurns?: object|null,
 *   replyEgress?: object|null,
 *   deliverTerminal?: Function|null,
 *   deliverText?: Function|null,
 *   onEvent?: Function|null,
 *   maxReasonersPerSession?: number,
 *   contextLines?: number,
 *   contextBytes?: number,
 *   log?: Function,
 * }} opts
 */
export function createReasoningCoordinator({
  taskStore,
  dispatcher = null,
  caller = null,
  brain,
  store = null,
  snapshotFn = null,
  activeBrainTurns = null,
  replyEgress = null,
  deliverTerminal = null,
  deliverText = null,
  onEvent = null,
  maxReasonersPerSession = 3,
  contextLines = 20,
  contextBytes = 8192,
  log = console.error,
} = {}) {
  if (!taskStore) throw new Error("createReasoningCoordinator: taskStore 必填");
  if (!brain || typeof brain.turn !== "function") throw new Error("createReasoningCoordinator: brain 必填");
  if (!Number.isSafeInteger(maxReasonersPerSession) || maxReasonersPerSession < 1) {
    throw new Error("maxReasonersPerSession 必须是正整数");
  }

  const emit = (evt) => { try { onEvent?.(evt); } catch { /* fail-safe */ } };
  const review = dispatcher?.review
    ?? (caller
      ? createDispatcher({ caller, onEvent, contextLines, contextBytes }).review
      : null);
  if (typeof review !== "function") {
    // applyDecision can still run when tests inject decisions directly; processDispatch needs review.
  }

  // sessionKey -> queue of waiting work when fairness cap is hit
  const waitQueues = new Map();
  const runningBySession = new Map(); // sessionKey -> Set(taskId)

  function sessionRunning(sessionKey) {
    return runningBySession.get(sessionKey) ?? new Set();
  }

  function trackStart(sessionKey, taskId) {
    const set = sessionRunning(sessionKey);
    set.add(taskId);
    runningBySession.set(sessionKey, set);
  }

  function trackEnd(sessionKey, taskId) {
    const set = sessionRunning(sessionKey);
    set.delete(taskId);
    if (!set.size) runningBySession.delete(sessionKey);
    else runningBySession.set(sessionKey, set);
    drainQueue(sessionKey);
  }

  function enqueue(sessionKey, job) {
    const q = waitQueues.get(sessionKey) ?? [];
    q.push(job);
    waitQueues.set(sessionKey, q);
  }

  function drainQueue(sessionKey) {
    const q = waitQueues.get(sessionKey);
    if (!q?.length) return;
    while (q.length && sessionRunning(sessionKey).size < maxReasonersPerSession) {
      const job = q.shift();
      void runJob(job).catch((e) => log(`[coordinator] queued job failed: ${e?.message ?? e}`));
    }
    if (!q.length) waitQueues.delete(sessionKey);
  }

  function taskExecutionKey(taskId) {
    return `task:${taskId}`;
  }

  async function closeReasonerLifecycle({ session, sessionKey, task, lifecycle }) {
    if (!lifecycle) return null;
    const currentTask = taskStore.getTask(task.id) ?? task;
    const executionKey = lifecycle.executionKey ?? taskExecutionKey(task.id);
    const hadFinalReply = Boolean(lifecycle.closing?.finalReceipt);
    if (!hadFinalReply && currentTask.closure_mode === "required") {
      if (typeof deliverTerminal !== "function") {
        throw new Error("coordinator: required closure 缺少 deliverTerminal");
      }
      const delivered = await deliverTerminal({
        deliverKey: sessionKey,
        sessionId: session.id,
        text: REQUIRED_CLOSURE_FALLBACK,
        source: "daemon_terminal_fallback",
        daemonRef: {
          sessionKey: lifecycle.sessionKey,
          turnId: lifecycle.turnId,
          lease: lifecycle.lease,
          taskId: task.id,
          executionKey,
        },
        idempotencyKey: `task:${task.id}:turn:${lifecycle.turnId}:terminal`,
        atomic: true,
      });
      emit({
        type: "handoff_sent",
        sessionKey,
        taskId: task.id,
        turnId: lifecycle.turnId,
        messageId: delivered?.messageId ?? null,
        source: "required_closure_fallback",
      });
    } else if (!hadFinalReply) {
      emit({ type: "silent_closed", sessionKey, taskId: task.id, turnId: lifecycle.turnId });
    } else {
      emit({
        type: "handoff_sent",
        sessionKey,
        taskId: task.id,
        turnId: lifecycle.turnId,
        messageId: lifecycle.closing.finalReceipt.messageId ?? null,
        source: lifecycle.closing.finalReceipt.source ?? "rendered_reply",
      });
    }

    if (!activeBrainTurns) return null;
    const outcome = activeBrainTurns.finalizeTurn(lifecycle.sessionKey, lifecycle.lease, {
      taskId: task.id,
      executionKey,
    });
    if (!outcome) throw new Error("coordinator: business lifecycle 未能终态化");
    return outcome;
  }

  function recycleTaintedResident({ sessionKey, task }) {
    const residentKey = taskExecutionKey(task.id);
    if (!replyEgress?.isTainted?.(sessionKey, { taskId: task.id, residentKey })) return;
    const reasons = replyEgress.taintReasons?.(sessionKey, { taskId: task.id, residentKey }) ?? [];
    emit({ type: "resident_taint_recycle", sessionKey, taskId: task.id, residentKey, reasons });
    brain.recycle?.(sessionKey, { taskId: task.id });
  }

  async function retryPendingSend({ dispatchId, session, sessionKey }) {
    const row = taskStore.getDispatch(dispatchId);
    if (!row) throw new Error("coordinator: pending_send dispatch 不存在");
    if (row.session_id !== session?.id) throw new Error("coordinator: pending_send 会话不匹配");
    if (row.status === "pending_review") return row;
    if (row.status !== "pending_send") throw new Error(`coordinator: pending_send 非法状态 ${row.status}`);
    if (typeof deliverText !== "function") throw new Error("coordinator: pending_send 缺少 deliverText");

    const { messageId } = await deliverText(sessionKey, row.responder_text, {
      idempotencyKey: row.outbound_idempotency_key,
    });
    const committed = taskStore.recordDispatchSent(dispatchId, {
      platformMessageId: messageId,
      appendAssistant: () => store.append(session.id, {
        role: "assistant",
        content: row.responder_text,
        platformMessageId: messageId,
        ts: Date.now(),
      }),
    });
    emit({
      type: "responder_send_recovered",
      sessionKey,
      dispatchId,
      messageId,
      idempotencyKey: row.outbound_idempotency_key,
    });
    return committed.dispatch;
  }

  async function startReasoner({ session, sessionKey, task, brief, messageIds = [] }) {
    const job = { session, sessionKey, task, brief, messageIds };
    if (sessionRunning(sessionKey).size >= maxReasonersPerSession) {
      enqueue(sessionKey, job);
      emit({ type: "reasoner_queued", sessionKey, taskId: task.id });
      return { queued: true, taskId: task.id };
    }
    void runJob(job).catch((e) => log(`[coordinator] reasoner failed: ${e?.message ?? e}`));
    return { queued: false, taskId: task.id };
  }

  async function runJob({ session, sessionKey, task, brief }) {
    trackStart(sessionKey, task.id);
    emit({ type: "reasoner_started", sessionKey, taskId: task.id });
    try {
      const result = await brain.turn({
        session,
        sessionKey,
        taskId: task.id,
        brief,
        purpose: "business",
        snapshot: typeof snapshotFn === "function" ? snapshotFn({ sessionKey }) : null,
      });
      await closeReasonerLifecycle({ session, sessionKey, task, lifecycle: result?.turnLifecycle ?? null });
      taskStore.transitionTask(task.id, {
        status: "completed",
        summary: typeof result?.finalText === "string" && result.finalText.trim()
          ? result.finalText.slice(0, 500)
          : null,
      });
      emit({ type: "reasoner_completed", sessionKey, taskId: task.id });
    } catch (e) {
      try {
        await closeReasonerLifecycle({ session, sessionKey, task, lifecycle: e?.turnLifecycle ?? null });
      } catch (closureError) {
        emit({ type: "reasoner_closure_failed", sessionKey, taskId: task.id, error: closureError?.message ?? closureError });
      }
      emit({ type: "task_failed", sessionKey, taskId: task.id, error: e?.message ?? e });
      try { taskStore.transitionTask(task.id, { status: "failed", summary: String(e?.message ?? e).slice(0, 200) }); } catch { /* */ }
      throw e;
    } finally {
      recycleTaintedResident({ sessionKey, task });
      trackEnd(sessionKey, task.id);
    }
  }

  /**
   * Apply a dispatcher decision after a pending_review claim.
   */
  async function applyDecision({
    session,
    sessionKey,
    decision,
    sourceMessageIds = [],
  }) {
    if (!decision || decision.action === "no_reasoning") {
      emit({ type: "dispatcher_decision", sessionKey, action: "no_reasoning", reason_code: decision?.reason_code });
      return { action: "no_reasoning" };
    }

    if (decision.action === "attach_existing") {
      const task = taskStore.getTask(decision.task_id);
      if (!task || task.session_id !== session.id) {
        emit({ type: "dispatcher_invalid", sessionKey, error: "fabricated_or_cross_session_task" });
        throw new Error("coordinator: attach 拒绝跨会话或不存在的 task");
      }
      const updatedTask = taskStore.mergeClosureMode(task.id, decision.closure ?? "silent_ok");
      for (const mid of sourceMessageIds) {
        taskStore.attachMessage({ taskId: task.id, messageId: mid, relation: "steer" });
      }
      emit({ type: "task_attached", sessionKey, taskId: task.id });

      if (brain.isBusy({ sessionKey, taskId: task.id })) {
        brain.steer(sessionKey, decision.brief, { taskId: task.id });
        return { action: "attach_existing", taskId: task.id, steered: true };
      }
      // Idle existing task: start a new run on the same task, do not create another task.
      await startReasoner({
        session,
        sessionKey,
        task: updatedTask,
        brief: decision.brief,
        messageIds: sourceMessageIds,
      });
      return { action: "attach_existing", taskId: task.id, steered: false, started: true };
    }

    if (decision.action === "spawn_new") {
      const task = taskStore.createTask({
        sessionId: session.id,
        title: decision.title || "新任务",
        summary: decision.brief?.slice(0, 200) ?? "",
        closureMode: decision.closure ?? "silent_ok",
      });
      for (const mid of sourceMessageIds) {
        taskStore.attachMessage({ taskId: task.id, messageId: mid, relation: "source" });
      }
      emit({ type: "task_created", sessionKey, taskId: task.id, title: task.title });
      await startReasoner({
        session,
        sessionKey,
        task,
        brief: decision.brief,
        messageIds: sourceMessageIds,
      });
      return { action: "spawn_new", taskId: task.id };
    }

    throw new Error(`coordinator: 未知 decision.action ${decision.action}`);
  }

  /**
   * Process one dispatch id: claim → review → apply → complete.
   * Returns immediately after scheduling reasoner work (background promises are caught).
   */
  async function processDispatch({
    dispatchId,
    session,
    sessionKey,
    items = [],
    mode = "p2p",
  }) {
    const claimed = taskStore.claimDispatchForReview(dispatchId);
    const sourceMessageIds = JSON.parse(claimed.source_message_ids_json ?? "[]");
    const effectiveItems = items.length ? items : taskStore.dispatchSourceItems(dispatchId);
    const excludedRecentIds = new Set([
      ...sourceMessageIds,
      ...(claimed.responder_message_id ? [claimed.responder_message_id] : []),
    ]);
    const recentRows = typeof store?.promptRecent === "function"
      ? store.promptRecent(session.id, { limit: 200, roles: ["user", "assistant"] })
        .filter((row) => !excludedRecentIds.has(row.id))
      : [];
    const candidates = taskStore.activeSummaries(session.id);

    if (typeof review !== "function") {
      throw new Error("coordinator: dispatcher/caller 未配置，无法 review");
    }
    let decision;
    try {
      decision = await review({
        sessionKey,
        items: effectiveItems,
        mode: claimed.mode || mode,
        responderAction: claimed.responder_action,
        responderText: claimed.responder_text,
        recentRows,
        activeTaskCandidates: candidates,
      });
      const result = await applyDecision({
        session,
        sessionKey,
        decision,
        sourceMessageIds,
      });
      taskStore.completeDispatch(dispatchId, { status: "done", verdict: decision });
      return { ok: true, decision, result };
    } catch (e) {
      taskStore.completeDispatch(dispatchId, {
        status: "failed",
        verdict: decision ?? { error: String(e?.message ?? e) },
      });
      throw e;
    }
  }

  /**
   * Schedule processing without awaiting reasoner completion.
   */
  function schedule(args) {
    const p = processDispatch(args).catch((e) => {
      log(`[coordinator] processDispatch failed: ${e?.message ?? e}`);
      emit({ type: "dispatch_failed", sessionKey: args.sessionKey, error: e?.message ?? e });
    });
    return p;
  }

  function resumePending({ limit = 50 } = {}) {
    taskStore.recoverStaleRunning();
    const rows = taskStore.listReviewQueue({ limit });
    return rows;
  }

  return {
    applyDecision,
    processDispatch,
    schedule,
    resumePending,
    startReasoner,
    retryPendingSend,
    maxReasonersPerSession,
  };
}

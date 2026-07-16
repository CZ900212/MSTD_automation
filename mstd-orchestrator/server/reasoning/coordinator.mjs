// Post-response coordinator: claim pending_review dispatches, call dispatcher, spawn/attach tasks.
import { createDispatcher } from "../models/dispatcher.mjs";
import { isValidOpenId } from "../safety/action-dsl.mjs";

const REQUIRED_CLOSURE_FALLBACK = "这次处理没能生成可安全发送的正式答复，请稍后重试。";
const REQUIRED_FAILURE_BRIEF = "这次处理未能完成，请告知用户稍后重试。";

/**
 * @param {{
 *   taskStore: ReturnType<import("./task-store.mjs").createReasoningTaskStore>,
 *   runStore: ReturnType<import("./run-store.mjs").createReasoningRunStore>,
 *   dispatcher?: { review: Function },
 *   caller?: { call: Function },
 *   brain: { turn: Function, steer: Function, isBusy: Function },
 *   store?: { promptRecent?: Function },
 *   snapshotFn?: Function|null,
 *   activeBrainTurns?: object|null,
 *   activeTurnInitiators?: object|null,
 *   replyEgress?: object|null,
 *   responder?: { renderHandoff: Function }|null,
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
  runStore,
  dispatcher = null,
  caller = null,
  brain,
  store = null,
  snapshotFn = null,
  activeBrainTurns = null,
  activeTurnInitiators = null,
  replyEgress = null,
  responder = null,
  deliverTerminal = null,
  deliverText = null,
  onEvent = null,
  maxReasonersPerSession = 3,
  contextLines = 20,
  contextBytes = 8192,
  log = console.error,
} = {}) {
  if (!taskStore) throw new Error("createReasoningCoordinator: taskStore 必填");
  if (!runStore) throw new Error("createReasoningCoordinator: runStore 必填");
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
  const scheduledRunIds = new Set();

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

  async function closeRun({ session, sessionKey, task, run, lifecycle = null, finalText = null, failed = false, dispatchId = null }) {
    let currentRun = runStore.getRun(run.id) ?? run;
    if (["completed", "failed", "interrupted", "cancelled"].includes(currentRun.status)) return currentRun;
    const executionKey = lifecycle?.executionKey ?? taskExecutionKey(task.id);
    const finalReceipt = lifecycle?.closing?.finalReceipt ?? null;
    if (finalReceipt && currentRun.closure_mode !== "required") {
      currentRun = runStore.upgradeClosure(run.id, "required");
    }

    if (currentRun.closure_mode === "required") {
      currentRun = runStore.claimClosure(run.id);
      let messageId = finalReceipt?.messageId ?? null;
      let safeFallback = finalReceipt?.source === "egress_safe_fallback"
        || finalReceipt?.outcome === "safe_fallback_sent";
      let source = finalReceipt?.source ?? "rendered_reply";

      if (!finalReceipt) {
        if (typeof deliverTerminal !== "function") {
          throw new Error("coordinator: required closure 缺少 deliverTerminal");
        }
        let terminalText = REQUIRED_CLOSURE_FALLBACK;
        safeFallback = true;
        source = "daemon_terminal_fallback";
        if (typeof responder?.renderHandoff === "function") {
          try {
            const rendered = await responder.renderHandoff({
              sessionKey,
              taskId: task.id,
              brief: typeof finalText === "string" && finalText.trim()
                ? finalText.trim()
                : REQUIRED_FAILURE_BRIEF,
              kind: "message",
              deliverKind: session?.kind === "group" ? "group" : "p2p",
            });
            if (typeof rendered?.text !== "string" || !rendered.text.trim()) {
              throw new Error("empty responder handoff");
            }
            terminalText = rendered.text.trim();
            safeFallback = false;
            source = failed ? "responder_failure_handoff" : "responder_handoff";
          } catch {
            emit({ type: "responder_handoff_fallback", sessionKey, taskId: task.id, runId: run.id, dispatchId });
          }
        }
        const delivered = await deliverTerminal({
          deliverKey: sessionKey,
          sessionId: session.id,
          text: terminalText,
          source,
          daemonRef: lifecycle ? {
            sessionKey: lifecycle.sessionKey,
            turnId: lifecycle.turnId,
            lease: lifecycle.lease,
            taskId: task.id,
            runId: run.id,
            executionKey,
          } : null,
          idempotencyKey: currentRun.terminal_idempotency_key,
          atomic: true,
        });
        messageId = delivered?.messageId ?? `daemon:${run.id}`;
      }
      currentRun = runStore.recordTerminal(run.id, {
        messageId,
        safeFallback,
        failureSummary: failed ? "reasoner_failed" : null,
      });
      emit({
        type: "handoff_sent",
        sessionKey,
        taskId: task.id,
        runId: run.id,
        dispatchId,
        turnId: lifecycle?.turnId ?? null,
        messageId,
        source,
      });
    } else {
      currentRun = runStore.closeSilent(run.id);
      emit({ type: "silent_closed", sessionKey, taskId: task.id, runId: run.id, dispatchId, turnId: lifecycle?.turnId ?? null });
    }

    if (activeBrainTurns && lifecycle) {
      const outcome = activeBrainTurns.finalizeTurn(lifecycle.sessionKey, lifecycle.lease, {
        taskId: task.id,
        runId: run.id,
        executionKey,
      });
      if (!outcome) throw new Error("coordinator: business lifecycle 未能终态化");
    }
    return currentRun;
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

  async function startReasoner({
    session,
    sessionKey,
    task,
    run,
    brief,
    messageIds = [],
    contextEnvelope = null,
    dispatchId = null,
    inputId = null,
  }) {
    if (scheduledRunIds.has(run.id)) {
      return { queued: run.status === "queued", alreadyScheduled: true, taskId: task.id, runId: run.id };
    }
    scheduledRunIds.add(run.id);
    const job = { session, sessionKey, task, run, brief, messageIds, contextEnvelope, dispatchId, inputId };
    if (sessionRunning(sessionKey).size >= maxReasonersPerSession) {
      enqueue(sessionKey, job);
      emit({ type: "reasoner_queued", sessionKey, taskId: task.id, runId: run.id, dispatchId });
      return { queued: true, taskId: task.id, runId: run.id };
    }
    void runJob(job).catch((e) => log(`[coordinator] reasoner failed: ${e?.message ?? e}`));
    return { queued: false, taskId: task.id, runId: run.id };
  }

  function preparePendingFollowup({ session, sessionKey, task, run }) {
    const inputs = runStore.pendingInputs(run.id);
    if (!inputs.length) return null;
    const first = inputs[0];
    const nextRun = runStore.createRun({
      taskId: task.id,
      parentRunId: run.id,
      originKind: first.origin_kind,
      originId: first.origin_id,
      closureMode: "required",
      brief: "处理上一轮闭合期间收到的服务端工具结果。",
    });
    for (const input of inputs) runStore.movePendingInput(input.id, nextRun.id);
    emit({
      type: "reasoner_inputs_carried",
      sessionKey,
      taskId: task.id,
      fromRunId: run.id,
      runId: nextRun.id,
      inputCount: inputs.length,
    });
    return {
      session,
      sessionKey,
      task,
      run: nextRun,
      brief: nextRun.brief,
      dispatchId: inputs.find((input) => input.dispatch_id)?.dispatch_id ?? null,
    };
  }

  // 写权限发起人：run 生效 dispatch 的 source 消息若来自唯一真实用户，则授其本回合写权限
  // （propose_actions 靠它绑定确认卡收件人）。多人批次/缺失/校验失败一律 null——
  // fail-closed，与 gateway wire 的单一发送者规则同语义。
  function resolveRunWriteInitiator(runId) {
    if (!runId) return null;
    try {
      const linked = runStore.listDispatches(runId);
      const items = linked.flatMap((link) => taskStore.dispatchSourceItems(link.dispatch_id));
      if (!items.length) return null;
      const senders = new Set();
      for (const item of items) {
        if (!isValidOpenId(item.senderOpenId)) return null;
        senders.add(item.senderOpenId);
      }
      return senders.size === 1 ? [...senders][0] : null;
    } catch {
      return null;
    }
  }

  async function runJob({
    session,
    sessionKey,
    task,
    run,
    brief,
    contextEnvelope = null,
    dispatchId = null,
    inputId = null,
  }) {
    trackStart(sessionKey, task.id);
    let closureAttempted = false;
    try {
      const turnId = `run:${run.id}:turn`;
      const residentKey = taskExecutionKey(task.id);
      run = runStore.startRun(run.id, { turnId, residentKey });
      const pendingInputs = runStore.pendingInputs(run.id);
      const pendingEnvelopes = pendingInputs.map(parseInputEnvelope).filter(Boolean);
      const effectiveEnvelopes = pendingEnvelopes.length
        ? pendingEnvelopes
        : (contextEnvelope ? [contextEnvelope] : []);
      const inputBriefs = pendingInputs.map((input) => input.brief).filter(Boolean);
      const effectiveBrief = inputBriefs.length
        ? [...new Set([brief, ...inputBriefs].filter(Boolean))].join("\n\n")
        : brief;
      const effectiveDispatchId = dispatchId
        ?? pendingInputs.find((input) => input.dispatch_id)?.dispatch_id
        ?? run.origin_dispatch_id
        ?? null;
      emit({ type: "reasoner_started", sessionKey, taskId: task.id, runId: run.id, dispatchId: effectiveDispatchId, turnId });
      const result = await brain.turn({
        session,
        sessionKey,
        taskId: task.id,
        runId: run.id,
        dispatchId: effectiveDispatchId,
        turnId,
        initiatorOpenId: resolveRunWriteInitiator(run.id),
        brief: effectiveBrief,
        contextEnvelopes: effectiveEnvelopes,
        contextSource: effectiveEnvelopes[0]?.source ?? "user",
        contextSensitivity: effectiveEnvelopes[0]?.sensitivity ?? "internal",
        purpose: "business",
        snapshot: typeof snapshotFn === "function" ? snapshotFn({ sessionKey }) : null,
      });
      for (const input of pendingInputs) runStore.markInputDelivered(input.id);
      if (inputId && !pendingInputs.some((input) => input.id === inputId)) runStore.markInputDelivered(inputId);
      const lifecycle = result?.turnLifecycle ?? null;
      closureAttempted = true;
      await closeRun({
        session,
        sessionKey,
        task,
        run,
        lifecycle,
        finalText: result?.finalText ?? null,
        dispatchId: effectiveDispatchId,
      });
      taskStore.updateTaskProgress(task.id, {
        summary: typeof result?.finalText === "string" && result.finalText.trim()
          ? result.finalText.slice(0, 500)
          : null,
      });
      emit({ type: "reasoner_completed", sessionKey, taskId: task.id, runId: run.id, dispatchId: effectiveDispatchId });
      const followup = preparePendingFollowup({ session, sessionKey, task, run });
      if (followup) {
        const scheduled = await startReasoner(followup);
        emit({
          type: scheduled.queued ? "reasoner_followup_queued" : "reasoner_followup_started",
          sessionKey,
          taskId: task.id,
          parentRunId: run.id,
          runId: followup.run.id,
        });
      }
    } catch (e) {
      if (!closureAttempted) {
        try {
          closureAttempted = true;
          await closeRun({
            session,
            sessionKey,
            task,
            run,
            lifecycle: e?.turnLifecycle ?? null,
            failed: true,
            dispatchId: run.origin_dispatch_id ?? dispatchId,
          });
        } catch (closureError) {
          emit({
            type: "reasoner_closure_failed",
            sessionKey,
            taskId: task.id,
            runId: run.id,
            error: closureError?.message ?? closureError,
          });
        }
      } else {
        emit({
          type: "reasoner_closure_failed",
          sessionKey,
          taskId: task.id,
          runId: run.id,
          error: e?.message ?? e,
        });
      }
      emit({ type: "run_failed", sessionKey, taskId: task.id, runId: run.id, dispatchId: run.origin_dispatch_id ?? dispatchId, error: e?.message ?? e });
      throw e;
    } finally {
      scheduledRunIds.delete(run.id);
      recycleTaintedResident({ sessionKey, task });
      trackEnd(sessionKey, task.id);
    }
  }

  async function recoverRuns({ resolveSession, limit = 100 } = {}) {
    if (typeof resolveSession !== "function") throw new Error("recoverRuns: resolveSession 必填");
    const results = [];
    for (const row of runStore.listRecoverableRuns({ limit })) {
      if (scheduledRunIds.has(row.id)) {
        results.push({ runId: row.id, taskId: row.task_id, status: "already_scheduled" });
        continue;
      }
      const task = taskStore.getTask(row.task_id);
      const session = resolveSession(row.session_id);
      if (!task || task.status !== "active" || !session || !row.origin_kind || !String(row.brief ?? "").trim()) {
        runStore.markInterrupted(row.id, { failureSummary: "startup_recovery_context_invalid" });
        results.push({ runId: row.id, taskId: row.task_id, status: "controlled" });
        continue;
      }
      const sessionKey = session.session_key;
      if (row.status === "queued") {
        const scheduled = await startReasoner({
          session,
          sessionKey,
          task,
          run: row,
          brief: row.brief,
          dispatchId: row.origin_dispatch_id,
        });
        results.push({
          runId: row.id,
          taskId: row.task_id,
          status: scheduled.queued ? "queued" : "started",
        });
        continue;
      }
      if (row.closure_mode === "silent_ok") {
        runStore.markInterrupted(row.id, { failureSummary: "startup_recovery_silent_run" });
        results.push({ runId: row.id, taskId: row.task_id, status: "interrupted" });
        continue;
      }
      try {
        await closeRun({ session, sessionKey, task, run: row, failed: true, dispatchId: row.origin_dispatch_id });
        results.push({ runId: row.id, taskId: row.task_id, status: "closed" });
      } catch (error) {
        log(`[coordinator] run recovery failed run=${row.id}: ${error?.message ?? error}`);
        emit({
          type: "reasoner_recovery_failed",
          sessionKey,
          taskId: row.task_id,
          runId: row.id,
        });
        results.push({ runId: row.id, taskId: row.task_id, status: "pending_send" });
      }
    }
    return results;
  }

  function parseInputEnvelope(row) {
    if (!row?.context_envelope_json) return null;
    try { return JSON.parse(row.context_envelope_json); }
    catch { return null; }
  }

  async function attachOrStart({
    session,
    sessionKey,
    taskId,
    parentRunId = null,
    originKind,
    originId,
    dispatchId = null,
    sessionVersion,
    brief,
    contextEnvelope = null,
    closureMode = "required",
  }) {
    const task = taskStore.getTask(taskId);
    if (!task) return { status: "controlled", reason: "missing_task", taskId };
    if (task.session_id !== session?.id) return { status: "controlled", reason: "task_session_mismatch", taskId };
    if (task.status !== "active") return { status: "controlled", reason: "terminal_task", taskId };
    if (parentRunId) {
      const parent = runStore.getRun(parentRunId);
      if (!parent) return { status: "controlled", reason: "missing_parent_run", taskId };
      if (parent.task_id !== taskId) return { status: "controlled", reason: "parent_task_mismatch", taskId };
    }

    let run = runStore.currentOpenRun(task.id);
    let input;
    if (run) {
      input = runStore.attachInput({
        runId: run.id,
        taskId: task.id,
        parentRunId,
        originKind,
        originId,
        dispatchId,
        sessionVersion,
        brief,
        contextEnvelope,
      });
      if (run.status !== "closing") run = runStore.upgradeClosure(run.id, closureMode);
      if (run.status === "running" && brain.isBusy({ sessionKey, taskId: task.id })) {
        const steered = brain.steer(sessionKey, brief, {
          taskId: task.id,
          runId: run.id,
          contextEnvelope,
        });
        if (steered) runStore.markInputDelivered(input.id);
        return { status: "attached", taskId: task.id, runId: run.id, steered };
      }
      return {
        status: run.status === "queued" ? "queued" : "attached",
        taskId: task.id,
        runId: run.id,
        steered: false,
      };
    }

    run = runStore.createRun({
      taskId: task.id,
      parentRunId,
      originKind,
      originId,
      closureMode,
      brief,
    });
    try {
      input = runStore.attachInput({
        runId: run.id,
        taskId: task.id,
        parentRunId,
        originKind,
        originId,
        dispatchId,
        sessionVersion,
        brief,
        contextEnvelope,
      });
    } catch (error) {
      try { runStore.markInterrupted(run.id, { failureSummary: "reinject input persistence failed" }); } catch { /* */ }
      throw error;
    }
    const scheduled = await startReasoner({
      session,
      sessionKey,
      task,
      run,
      brief,
      contextEnvelope: parseInputEnvelope(input),
      dispatchId,
      inputId: input.id,
    });
    return {
      status: scheduled.queued ? "queued" : "started",
      taskId: task.id,
      runId: run.id,
      steered: false,
    };
  }

  /**
   * Apply a dispatcher decision after a pending_review claim.
   */
  async function applyDecision({
    session,
    sessionKey,
    decision,
    sourceMessageIds = [],
    dispatchId = null,
  }) {
    if (!decision || decision.action === "no_reasoning") {
      emit({ type: "dispatcher_decision", sessionKey, dispatchId, action: "no_reasoning", reason_code: decision?.reason_code });
      return { action: "no_reasoning" };
    }

    if (decision.action === "attach_existing") {
      const task = taskStore.getTask(decision.task_id);
      if (!task || task.session_id !== session.id) {
        emit({ type: "dispatcher_invalid", sessionKey, dispatchId, error: "fabricated_or_cross_session_task" });
        throw new Error("coordinator: attach 拒绝跨会话或不存在的 task");
      }
      if (task.status !== "active") {
        emit({ type: "dispatcher_invalid", sessionKey, dispatchId, error: "terminal_task_attach" });
        throw new Error("coordinator: attach 只接受 active task");
      }
      for (const mid of sourceMessageIds) {
        taskStore.attachMessage({ taskId: task.id, messageId: mid, relation: "steer" });
      }
      const openRun = runStore.currentOpenRun(task.id);
      if (openRun) {
        if (dispatchId) runStore.attachDispatch(openRun.id, dispatchId, { relation: "attach" });
        const updatedRun = runStore.upgradeClosure(openRun.id, decision.closure ?? "silent_ok");
        emit({ type: "task_attached", sessionKey, taskId: task.id, runId: updatedRun.id, dispatchId });
        if (updatedRun.status === "running" && brain.isBusy({ sessionKey, taskId: task.id })) {
          if (!resolveRunWriteInitiator(updatedRun.id)) {
            activeTurnInitiators?.revokeAuthorized?.({ sessionKey, taskId: task.id, runId: updatedRun.id });
          }
          brain.steer(sessionKey, decision.brief, { taskId: task.id, runId: updatedRun.id });
          return { action: "attach_existing", taskId: task.id, runId: updatedRun.id, steered: true };
        }
        return { action: "attach_existing", taskId: task.id, runId: updatedRun.id, steered: false, attached: true };
      }
      // Idle existing task: start a new run on the same task, do not create another task.
      const run = runStore.createRun({
        taskId: task.id,
        originDispatchId: dispatchId,
        originKind: "dispatcher",
        originId: dispatchId,
        closureMode: decision.closure ?? "silent_ok",
        brief: decision.brief,
      });
      const scheduled = await startReasoner({
        session,
        sessionKey,
        task,
        run,
        brief: decision.brief,
        messageIds: sourceMessageIds,
      });
      return { action: "attach_existing", taskId: task.id, runId: run.id, steered: false, started: true, queued: scheduled.queued };
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
      const run = runStore.createRun({
        taskId: task.id,
        originDispatchId: dispatchId,
        originKind: "dispatcher",
        originId: dispatchId,
        closureMode: decision.closure ?? "silent_ok",
        brief: decision.brief,
      });
      emit({ type: "task_created", sessionKey, taskId: task.id, runId: run.id, dispatchId, title: task.title });
      const scheduled = await startReasoner({
        session,
        sessionKey,
        task,
        run,
        brief: decision.brief,
        messageIds: sourceMessageIds,
      });
      return { action: "spawn_new", taskId: task.id, runId: run.id, queued: scheduled.queued };
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
        dispatchId,
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
        dispatchId,
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
    attachOrStart,
    retryPendingSend,
    recoverRuns,
    maxReasonersPerSession,
  };
}

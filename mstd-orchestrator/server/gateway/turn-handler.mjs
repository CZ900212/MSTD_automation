import { randomUUID } from "node:crypto";
import { formatHistoryLine, whoLabel } from "../sessions/history-format.mjs";
import { NUDGE_MAINTENANCE_BRIEF } from "../memory/compact.mjs";
import { createActiveTurnRegistry } from "../sessions/active-turn.mjs";
import { createReplyPipeline } from "./reply-pipeline.mjs";
import { DEFAULT_RESPONDER_HISTORY_TOKENS, tokenWindow } from "../models/token-window.mjs";

// 群窗口时间戳:北京时间 HH:MM
const HHMM = new Intl.DateTimeFormat("zh-CN", { timeZone: "Asia/Shanghai", hour: "2-digit", minute: "2-digit", hour12: false });

// 回合执行器：triage 四选一 → quick_reply 直出 / no_reply 落 observed / steer 注入 / escalate 走 brain。
// 结构性强制：brain 的 finalText 永不出站；5.5 只能经 reply 工具（handleReply）表达。
// 物理出站与渲染统一在 reply-pipeline；这里只保留入站回合流转与 business turn 终态化。

const BUDGET_REFUSAL = "今天的对话额度已用完，暂时无法继续处理。请稍后再试或联系管理员调整额度。";
export const DAEMON_TERMINAL_FALLBACK = "这次处理没能生成可安全发送的正式答复，请稍后重试。";

export function createTurnHandler({
  triage,
  brain,
  renderReply,
  outbound,
  store,
  budget,
  soul = "",
  snapshotFn = null,          // C4 接缝：({sessionKey}) => 记忆快照
  compactor = null,           // C6 接缝：上下文压缩器
  journal = null,             // C7 接缝：公司总日志（fire-and-forget）
  limiter = null,             // F2 接缝：群主动发言限额器（ambient 专用）
  db = null,                  // F5 接缝：观察期 observe_log 落库
  grants = null,              // C0.4 接缝：reply.target 投递授权表（缺省 fail-closed：只许本会话）
  replyEgress = null,         // Batch C：常驻 Pi 生命周期绑定的 server-owned provenance/epoch
  verbatimGuard = null,       // Batch C：逐字引用守卫（群禁止/私聊预算，比对已读源 shingle）
  internalDisclosure = null,  // 内部实现披露 scanner
  activeTurns = null,         // daemon-issued business turn identity + formal reply receipt
  activeBrainTurns = null,    // 当前 Pi execution 的 daemon turnId/purpose 绑定
  caller = null,              // 供 renderReply 使用（renderReply 已柯里化时可为 null）
  replyPipeline = null,       // 5d：出站流水线；index.mjs 装配期先建 pipeline 再建 turnHandler
  // Responder–Dispatcher–Reasoner (architecture modes: legacy|shadow|active)
  architectureMode = "legacy",
  responder = null,
  dispatcher = null,
  taskStore = null,
  coordinator = null,
  responderHistoryTokens = DEFAULT_RESPONDER_HISTORY_TOKENS,
  onEvent = () => {},         // 回合事件（SSE/调试台接缝）
  log = console.error,
} = {}) {
  if (typeof store?.promptRecent !== "function") {
    throw new Error("createTurnHandler: store.promptRecent 安全接口必填");
  }
  const pipeline = replyPipeline ?? createReplyPipeline({
    outbound, store, budget, renderReply, caller, soul, snapshotFn,
    grants, replyEgress, verbatimGuard, internalDisclosure, activeBrainTurns, onEvent, log,
  });
  const { deliverText, deliverTerminal, handleReply, renderAutomationReply, deliverTrusted } = pipeline;
  const receipts = activeTurns ?? createActiveTurnRegistry().receipts;

  async function sendAndRecord(sessionKey, sessionId, text) {
    const { messageId } = await deliverText(sessionKey, text);
    store.append(sessionId, { role: "assistant", content: text, platformMessageId: messageId, ts: Date.now() });
    return { messageId };
  }

  function appendItems(sessionId, items, { observed = false } = {}) {
    return items.map((it) => store.append(sessionId, {
        role: "user",
        senderOpenId: it.senderOpenId ?? null,
        senderName: it.senderName ?? null,
        content: it.content,
        observed,
        platformMessageId: it.platformMessageId ?? null,
        ts: it.ts,
      }));
  }

  function renderContext(items) {
    return items.map((it) => `[${it.senderName ?? it.senderOpenId ?? "用户"}]: ${it.content}`).join("\n");
  }

  function recentConversationBeforeTurn(sessionId) {
    // SQL limit is only a defensive retrieval ceiling. The semantic boundary is
    // the strict token window, selected newest-first and rendered chronologically.
    // 8,192-token 窗口在极短行场景下最多约 4k 行；5_000 留安全裕量，避免大会话每回合物化上万行。
    const rows = store.promptRecent(sessionId, { limit: 5_000, roles: ["user", "assistant"] });
    const window = tokenWindow(rows, {
      budget: responderHistoryTokens,
      format: formatHistoryLine,
    });
    return { ...window, text: window.lines.join("\n"), rowCount: rows.length };
  }

  function beginBusinessTurn(sessionKey, emitEvent = onEvent) {
    const turn = receipts.begin({ sessionKey, purpose: "business", expectsReply: true });
    emitEvent({ type: "business_turn_admitted", sessionKey, turnId: turn.turnId, purpose: turn.purpose });
    return turn;
  }

  async function terminalizeBusinessTurn(turn, session, turnLifecycle = null) {
    const current = receipts.resolve(turn.sessionKey);
    if (current?.turnId === turn.turnId && current.state === "terminal") return current;
    if (turnLifecycle?.closing?.finalReceipt) {
      const receipt = receipts.resolve(turn.sessionKey);
      if (receipt?.turnId === turn.turnId && receipt.state === "terminal") return receipt;
      throw new Error("brain 已记录 final delivery，但 business receipt 未终态化");
    }
    const daemonRef = turnLifecycle && activeBrainTurns
      ? { sessionKey: turnLifecycle.sessionKey, turnId: turnLifecycle.turnId, lease: turnLifecycle.lease }
      : null;
    const { messageId, receipt, recordedOk } = await deliverTerminal({
      deliverKey: turn.sessionKey,
      sessionId: session.id,
      text: DAEMON_TERMINAL_FALLBACK,
      source: "daemon_terminal_fallback",
      daemonRef,
      idempotencyKey: `turn:${turn.turnId}:terminal`,
    });
    if (daemonRef && !recordedOk) {
      onEvent({
        type: "brain_turn_delivery_record_failed",
        sessionKey: turn.sessionKey,
        turnId: turn.turnId,
        source: "daemon_terminal_fallback",
        messageId,
      });
    }
    if (receipt) return receipt;
    // 注册表没有联动终态化（brain 无 lifecycle / 降级拓扑）：直接终态化 receipt 并发事件，
    // handleTurn 返回值契约 {turnId, receipt} 不变。
    const completed = receipts.complete(turn, { outcome: "daemon_fallback_sent", messageId });
    if (!completed.ok) {
      throw new Error(`daemon fallback 回执提交失败: ${completed.code}`);
    }
    onEvent({
      type: "business_turn_terminal",
      fallback_kind: "daemon_terminal",
      sessionKey: turn.sessionKey,
      turnId: turn.turnId,
      outcome: "daemon_fallback_sent",
      messageId,
    });
    return completed.receipt;
  }

  function finalizeBrainLifecycle(turnLifecycle) {
    if (!turnLifecycle || !activeBrainTurns) return null;
    return activeBrainTurns.finalizeTurn(turnLifecycle.sessionKey, turnLifecycle.lease);
  }

  function emitBrainOutcome(turnOutcome, { sessionKey, turnId, missing = "reply_missing" }) {
    if (!turnOutcome) return;
    onEvent({
      type: "brain_turn_outcome",
      sessionKey,
      turnId: turnOutcome.turnId ?? turnId,
      purpose: turnOutcome.purpose,
      outcome: turnOutcome.finalReceipt?.source ?? missing,
      stage: turnOutcome.finalReceipt?.stage ?? null,
      provider: turnOutcome.provider,
      replyCounts: turnOutcome.replyCounts,
    });
  }

  /**
   * Active architecture: responder speaks first; dispatcher/reasoner run after pending_review.
   * Does not wait for reasoner completion (non-blocking foreground).
   */
  async function handleTurnActive(turn, emitEvent) {
    const { session, sessionKey, items, mode } = turn;
    if (!responder || !taskStore || !coordinator) {
      throw new Error("active mode requires responder, taskStore, and coordinator");
    }
    if (!budget.allow(sessionKey).ok) {
      appendItems(session.id, items, { observed: mode === "observe_only" });
      // 观察期绝不出站：预算兜底话术也不例外
      if (mode !== "observe_only") await sendAndRecord(sessionKey, session.id, BUDGET_REFUSAL);
      return;
    }
    if (mode === "ambient" && limiter && session.chat_id && !limiter.allow(session.chat_id, Date.now())) {
      appendItems(session.id, items, { observed: true });
      emitEvent({ type: "rate_limited", sessionKey });
      return;
    }

    // 观察期（F5）：应答机照常判定但绝不出站、不进调度器/推理机；判定结果落 observe_log。
    if (mode === "observe_only") {
      appendItems(session.id, items, { observed: true });
      const obsSnapshot = snapshotFn ? snapshotFn({ sessionKey }) : null;
      let answer = null;
      try {
        answer = await responder.answerTurn({
          sessionKey,
          items,
          mode,
          snapshot: obsSnapshot,
          soul: obsSnapshot?.soul ?? soul,
          recentConversation: recentConversationBeforeTurn(session.id).text,
        });
      } catch (e) {
        log(`[turn] observe_only responder 判定失败 session=${sessionKey}: ${e?.message ?? e}`);
      }
      if (db) {
        db.prepare("INSERT INTO observe_log (id, chat_id, action, text, ts) VALUES (?, ?, ?, ?, ?)")
          .run(randomUUID(), session.chat_id, answer?.action ?? "responder_error",
            answer?.action === "reply" ? answer.text : null, Date.now());
      }
      emitEvent({ type: "observe_only", sessionKey, verdict: { action: answer?.action ?? "responder_error" } });
      return { action: "observe_only" };
    }

    const snapshot = snapshotFn ? snapshotFn({ sessionKey }) : null;
    const recentWindow = recentConversationBeforeTurn(session.id);
    const recentConversation = recentWindow.text;
    if (recentWindow.truncated) emitEvent({
      type: "responder_history_truncated",
      sessionKey,
      tokenBudget: responderHistoryTokens,
      selectedTokens: recentWindow.tokens,
      sourceRows: recentWindow.rowCount,
    });
    // Append first so source message ids exist for dispatch batch identity.
    const sourceRows = appendItems(session.id, items, { observed: mode === "ambient" });
    const sourceMessageIds = sourceRows.map((row) => row.id);

    const answer = await responder.answerTurn({
      sessionKey,
      items,
      mode,
      snapshot,
      soul: snapshot?.soul ?? soul,
      recentConversation,
    });

    if (answer.action === "no_reply") {
      const dispatch = taskStore.createDispatch({
        sessionId: session.id,
        sourceMessageIds,
        responderAction: "no_reply",
        mode,
      });
      emitEvent({
        type: "responder_sent",
        sessionKey,
        action: "no_reply",
        reason_code: answer.meta?.reasonCode ?? null,
        dispatchId: dispatch.id,
      });
      coordinator.schedule({
        dispatchId: dispatch.id,
        session,
        sessionKey,
        items,
        mode,
      });
      scheduleMaintenanceOutsideActor({ session, sessionKey, snapshot, emitEvent });
      return { action: "no_reply", dispatchId: dispatch.id };
    }

    // reply path: pending_send → physical send → pending_review → coordinator
    const dispatch = taskStore.createDispatch({
      sessionId: session.id,
      sourceMessageIds,
      responderAction: "reply",
      responderText: answer.text,
      mode,
    });
    let messageId;
    try {
      ({ messageId } = await deliverText(sessionKey, answer.text, {
        idempotencyKey: dispatch.outbound_idempotency_key,
      }));
    } catch (err) {
      // 物理发送失败时 actor 会吞异常；必须先落可观测事件，避免 turn_trace 卡在 batch_open。
      // dispatch 停在 pending_send，coordinator 仍可后续恢复重投。
      emitEvent({
        type: "responder_send_failed",
        sessionKey,
        action: "reply",
        dispatchId: dispatch.id,
        error: err?.message ?? String(err),
      });
      throw err;
    }
    taskStore.recordDispatchSent(dispatch.id, {
      platformMessageId: messageId,
      appendAssistant: () => store.append(session.id, {
        role: "assistant",
        content: answer.text,
        platformMessageId: messageId,
        ts: Date.now(),
      }),
    });
    emitEvent({
      type: "responder_sent",
      sessionKey,
      action: "reply",
      reason_code: answer.meta?.reasonCode ?? null,
      dispatchId: dispatch.id,
      messageId,
    });
    if (mode === "ambient" && limiter && session.chat_id) limiter.record(session.chat_id, Date.now());
    journal?.recordTurn({ sessionKey, sessionTitle: session.title, items, replyText: answer.text });
    coordinator.schedule({
      dispatchId: dispatch.id,
      session,
      sessionKey,
      items,
      mode,
    });
    scheduleMaintenanceOutsideActor({ session, sessionKey, snapshot, emitEvent });
    return { action: "reply", dispatchId: dispatch.id, messageId };
  }

  /** Shadow mode: keep the legacy user path authoritative and observe the new chain off-actor. */
  function observeTurnShadow(turn, emitEvent) {
    const { session, sessionKey, items, mode } = turn;
    if (!responder) return;
    const snapshot = snapshotFn ? snapshotFn({ sessionKey }) : null;
    const recentRows = store.promptRecent(session.id, { limit: 200, roles: ["user", "assistant"] });
    const recentConversation = recentConversationBeforeTurn(session.id).text;
    const activeTaskCandidates = taskStore?.activeSummaries?.(session.id) ?? [];
    void (async () => {
      const answer = await responder.answerTurn({
        sessionKey,
        items,
        mode,
        snapshot,
        soul: snapshot?.soul ?? soul,
        recentConversation,
      });
      emitEvent({
        type: "shadow_responder",
        sessionKey,
        action: answer.action,
        text: answer.action === "reply" ? answer.text : null,
      });
      if (typeof dispatcher?.review !== "function") return;
      const decision = await dispatcher.review({
        sessionKey,
        items,
        mode,
        responderAction: answer.action,
        responderText: answer.action === "reply" ? answer.text : null,
        recentRows,
        activeTaskCandidates,
      });
      emitEvent({
        type: "shadow_dispatcher",
        sessionKey,
        action: decision.action,
        reason_code: decision.reason_code ?? null,
      });
    })().catch((error) => {
      log(`[turn] shadow observation failed session=${sessionKey}: ${error?.message ?? error}`);
      emitEvent({ type: "shadow_error", sessionKey, error: String(error?.message ?? error) });
    });
  }

  async function handleTurnShadow(turn, emitEvent) {
    observeTurnShadow(turn, emitEvent);
    return handleTurnLegacy(turn, emitEvent);
  }

  function scheduleMaintenanceOutsideActor({ session, sessionKey, snapshot, emitEvent }) {
    // Fire-and-forget so later responder turns are not blocked by nudge/compact.
    void (async () => {
      try {
        const nudgePoint = store.peekMemoryNudge?.(session.id);
        if (nudgePoint) {
          await brain.turn({
            session,
            sessionKey,
            turnId: randomUUID(),
            purpose: "memory_maintenance",
            brief: NUDGE_MAINTENANCE_BRIEF,
            snapshot,
          });
          store.claimMemoryNudge?.(session.id, { point: nudgePoint });
        }
        if (compactor) await compactor.maybeCompact({ session, sessionKey, brain, snapshot });
      } catch (e) {
        log(`[turn] maintenance outside actor failed session=${sessionKey}: ${e?.message ?? e}`);
        emitEvent({ type: "memory_maintenance_error", sessionKey, error: String(e?.message ?? e) });
      }
    })();
  }

  async function handleTurn(turn) {
    const { kind, session, sessionKey, items, mode, traceId = null } = turn;
    // Bind traceId for this turn so model_log + turn_trace share the same key.
    const emitEvent = (event) => {
      if (traceId && event && typeof event === "object" && !event.traceId) {
        onEvent({ ...event, traceId });
      } else {
        onEvent(event);
      }
    };
    if (kind !== "message") {
      // card_action / minutes：Phase D/E 接缝
      return emitEvent({ type: "unhandled_kind", kind, turn });
    }

    const effectiveArchitectureMode = turn.architectureMode ?? architectureMode;
    if (effectiveArchitectureMode === "active") return handleTurnActive(turn, emitEvent);
    if (effectiveArchitectureMode === "shadow") return handleTurnShadow(turn, emitEvent);
    return handleTurnLegacy(turn, emitEvent);
  }

  async function handleTurnLegacy(turn, emitEvent) {
    const { session, sessionKey, items, mode } = turn;

    if (!budget.allow(sessionKey).ok) {
      appendItems(session.id, items, { observed: mode === "observe_only" });
      // 观察期绝不出站：预算兜底话术也不例外
      if (mode !== "observe_only") await sendAndRecord(sessionKey, session.id, BUDGET_REFUSAL);
      return;
    }

    // 门控第 0 层（规则）：ambient 先过限额，不过直接 observed 落库（零模型成本）
    if (mode === "ambient" && limiter && session.chat_id && !limiter.allow(session.chat_id, Date.now())) {
      appendItems(session.id, items, { observed: true });
      emitEvent({ type: "rate_limited", sessionKey });
      return;
    }

    const snapshot = snapshotFn ? snapshotFn({ sessionKey }) : null;
    const triageStartedAt = Date.now();
    const verdict = await triage.triage({ session, items, mode, snapshot, brainBusy: brain.isBusy(sessionKey) });
    emitEvent({
      type: "triage",
      sessionKey,
      verdict,
      action: verdict.action,
      sourceAction: verdict.meta?.sourceAction ?? verdict.action,
      provider: verdict.meta?.provider ?? null,
      guard: verdict.meta?.guard ?? null,
      latencyMs: Date.now() - triageStartedAt,
    });

    // ambient 放行出站前记账（quick_reply/escalate 都算一次主动发言）
    if (mode === "ambient" && limiter && session.chat_id && (verdict.action === "quick_reply" || verdict.action === "escalate")) {
      limiter.record(session.chat_id, Date.now());
    }

    // 观察期：判定结果落 observe_log，消息进 observed 上下文，绝不出站/不进中枢
    if (mode === "observe_only") {
      appendItems(session.id, items, { observed: true });
      if (db) {
        db.prepare("INSERT INTO observe_log (id, chat_id, action, text, ts) VALUES (?, ?, ?, ?, ?)")
          .run(randomUUID(), session.chat_id, verdict.action, verdict.text ?? verdict.brief ?? null, Date.now());
      }
      emitEvent({ type: "observe_only", sessionKey, verdict });
      return;
    }

    if (verdict.action === "no_reply") {
      appendItems(session.id, items, { observed: true });
      emitEvent({ type: "no_reply", sessionKey, action: "no_reply" });
      return;
    }

    if (verdict.action === "steer" && brain.isBusy(sessionKey)) {
      appendItems(session.id, items);
      brain.steer(sessionKey, verdict.note ?? renderContext(items));
      return;
    }

    // C3.3 滚动窗口：在本批落库之前取"截至本批之前"的最近 30 条(user/assistant,含自身发言),
    // 一次性 observed 消费机制已退役——复述二连问不再丢上下文。who 标注与 formatHistoryLine 同源。
    // 只有 escalate/steer(空闲) 用得上窗口;quick_reply 不白算这次 DB 读。
    let windowBlock = "";
    if ((verdict.action === "escalate" || verdict.action === "steer")
      && mode === "addressed" && sessionKey.startsWith("feishu:group:")) {
      const win = store.promptRecent(session.id, { limit: 30, roles: ["user", "assistant"] });
      if (win.length) {
        windowBlock = win.map((m) =>
          `${HHMM.format(new Date(m.ts))} [${whoLabel(m, { fallback: "群成员" })}]: ${m.content}`
        ).join("\n");
      }
    }
    appendItems(session.id, items);

    if (verdict.action === "quick_reply") {
      const { messageId } = await sendAndRecord(sessionKey, session.id, verdict.text);
      journal?.recordTurn({ sessionKey, sessionTitle: session.title, items, replyText: verdict.text });
      emitEvent({ type: "quick_reply_sent", sessionKey, messageId, action: "quick_reply" });
      return;
    }

    // escalate（或 steer 但中枢已空闲 → 当 escalate 跑）进入 daemon-owned business turn。
    // ACK 只是该 turn 的非终态 effect；只有正式 reply / 安全 fallback / daemon fallback 才能收口。
    const businessTurn = beginBusinessTurn(sessionKey, emitEvent);
    if (verdict.ack?.trim()) {
      try {
        const ackText = verdict.ack.trim();
        const { messageId } = await sendAndRecord(sessionKey, session.id, ackText);
        receipts.recordAck(businessTurn, { messageId });
        emitEvent({ type: "business_turn_ack", sessionKey, turnId: businessTurn.turnId, messageId, terminal: false });
      } catch (e) {
        log(`[turn] ack 出站失败 session=${sessionKey}: ${e?.message ?? e}`); // ack 失败不阻断慢机
      }
    }
    const brief = verdict.brief ?? verdict.note ?? renderContext(items);
    let context = renderContext(items);
    if (windowBlock) context = `[群内最近消息-截至本批之前]\n${windowBlock}\n[/群内最近消息]\n\n${context}`;
    let receipt = null;
    let turnLifecycle = null;
    let turnOutcome = null;
    let brainError = null;
    try {
      const result = await brain.turn({
        session,
        sessionKey,
        turnId: businessTurn.turnId,
        purpose: "business",
        brief,
        context,
        snapshot,
        initiatorOpenId: turn.initiatorOpenId ?? null,
      });
      turnLifecycle = result.turnLifecycle ?? null;
      for (const e of result.events ?? []) emitEvent({ type: "brain_event", sessionKey, turnId: businessTurn.turnId, event: e });
      // finalText 只落库为内部记录（role=tool），绝不出站或充当终态回执。
      if (result.finalText) {
        try {
          store.append(session.id, {
            role: "tool",
            content: `[中枢内部结论] ${result.finalText.slice(0, 2000)}`,
            ts: Date.now(),
            policy: {
              replayable: false,
              promptEligible: false,
              memoryEligible: false,
              securityLabel: "internal",
              provenance: "tool_internal",
            },
          });
        } catch (error) {
          log(`[turn] 中枢内部结论落库失败 session=${sessionKey}: ${error?.message ?? error}`);
        }
      }
      receipt = await terminalizeBusinessTurn(businessTurn, session, turnLifecycle);
      journal?.recordTurn({ sessionKey, sessionTitle: session.title, items, replyText: "" });
    } catch (e) {
      brainError = e;
      turnLifecycle = e?.turnLifecycle ?? turnLifecycle;
      log(`[turn] brain 回合失败 session=${sessionKey}: ${e?.message ?? e}`);
      emitEvent({ type: "brain_error", sessionKey, turnId: businessTurn.turnId, error: String(e?.message ?? e) });
      try {
        receipt = await terminalizeBusinessTurn(businessTurn, session, turnLifecycle);
      } catch (terminalizeError) {
        log(`[turn] 终态化失败 session=${sessionKey}: ${terminalizeError?.message ?? terminalizeError}`);
        emitEvent({
          type: "business_turn_terminalize_failed",
          sessionKey,
          turnId: businessTurn.turnId,
          error: String(terminalizeError?.message ?? terminalizeError),
        });
      }
    } finally {
      turnOutcome = finalizeBrainLifecycle(turnLifecycle);
      emitBrainOutcome(turnOutcome, {
        sessionKey,
        turnId: businessTurn.turnId,
        missing: brainError ? "error_without_reply" : "reply_missing",
      });
      // 无论是否终态化成功都必须释放槽位：没有任何重试消费者，留 active 即永久卡死本会话
      // （后续消息在 begin() 同步抛错并被 actor 队列静默吞掉）。
      if (receipt?.state !== "terminal") {
        emitEvent({ type: "business_turn_abandoned", sessionKey, turnId: businessTurn.turnId });
      }
      receipts.clear(businessTurn);
    }

    // 记忆维护与业务 turn 完全分离：业务已终态并解除 receipt 后，另起静默 maintenance turn。
    const nudgePoint = store.peekMemoryNudge(session.id);
    if (nudgePoint) {
      try {
        await brain.turn({
          session,
          sessionKey,
          turnId: randomUUID(),
          purpose: "memory_maintenance",
          brief: NUDGE_MAINTENANCE_BRIEF,
          snapshot,
        });
        store.claimMemoryNudge(session.id, { point: nudgePoint });
      } catch (e) {
        log(`[turn] memory maintenance 失败 session=${sessionKey}: ${e?.message ?? e}`);
        emitEvent({ type: "memory_maintenance_error", sessionKey, error: String(e?.message ?? e) });
      }
    }
    if (compactor) {
      try {
        await compactor.maybeCompact({ session, sessionKey, brain, snapshot });
      } catch (e) {
        log(`[turn] compact 失败 session=${sessionKey}: ${e?.message ?? e}`);
        emitEvent({ type: "compact_error", sessionKey, error: String(e?.message ?? e) });
      }
    }
    // 批次 C taint→recycle：resident 本回合（epoch）看过席位私有数据，业务回合收口后
    // 立即回收进程，防止后续回合凭跨回合记忆外泄。新 spawn 领新 epoch，taint 自动失效。
    // 源 shingle 保留（server-owned 已读记录）：重生 Pi 经重放拿到旧内容照样受逐字守卫约束。
    if (replyEgress?.isTainted?.(sessionKey)) {
      const reasons = replyEgress.taintReasons?.(sessionKey) ?? [];
      emitEvent({ type: "resident_taint_recycle", sessionKey, reasons });
      brain.recycle?.(sessionKey);
    }
    return { turnId: businessTurn.turnId, receipt };
  }
  return { handleTurn, handleReply, renderAutomationReply, deliverTrusted };
}

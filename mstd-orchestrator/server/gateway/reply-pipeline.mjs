import { randomUUID } from "node:crypto";
import { parseSessionKey } from "../sessions/session-key.mjs";
import { formatHistoryLine } from "../sessions/history-format.mjs";
import { hasRichMarkdown } from "./md-detect.mjs";
import { buildMarkdownMessageCard } from "../cards/templates.mjs";
import { SAFE_REPLY_FALLBACK, createReplyEgressChecker } from "../safety/reply-egress.mjs";

// 出站回复流水线：渲染（respond 链）→ egress 门禁 → 唯一物理出口 → transcript 落库。
// turn-handler 只保留入站回合流转，所有物理出站都从这里走。

// admission drain deadline 支撑:signal 为空或从不 abort 时与直接 await 完全等价;
// abort 后本 helper 立刻以 signal.reason 拒绝,底层 promise 自行收尾(其结果不再被消费)。
function abortable(promise, signal) {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(signal.reason ?? new Error("operation aborted"));
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason ?? new Error("operation aborted"));
    signal.addEventListener("abort", abort, { once: true });
    Promise.resolve(promise).then(
      (value) => {
        signal.removeEventListener("abort", abort);
        resolve(value);
      },
      (error) => {
        signal.removeEventListener("abort", abort);
        reject(error);
      },
    );
  });
}

export function createReplyPipeline({
  outbound,
  store,
  budget,
  renderReply,
  caller = null,              // 供 renderReply 使用（renderReply 已柯里化时可为 null）
  soul = "",
  snapshotFn = null,          // C4 接缝：({sessionKey}) => 记忆快照
  grants = null,              // C0.4 接缝：reply.target 投递授权表（缺省 fail-closed：只许本会话）
  replyEgress = null,         // Batch C：常驻 Pi 生命周期绑定的 server-owned provenance/epoch
  verbatimGuard = null,       // Batch C：逐字引用守卫（群禁止/私聊预算，比对已读源 shingle）
  activeBrainTurns = null,    // 当前 Pi execution 的 daemon turnId/purpose 绑定
  onEvent = () => {},
  log = console.error,
} = {}) {
  if (typeof store?.promptRecent !== "function") {
    throw new Error("createReplyPipeline: store.promptRecent 安全接口必填");
  }
  // 进程级 egress 依赖装配期绑定一次；automation 是 daemon-only 场景，走无 registry 语义。
  const egress = createReplyEgressChecker({ registry: replyEgress, verbatimGuard });
  const automationEgress = createReplyEgressChecker();

  // C6 唯一文本出口:命中富 Markdown → 消息卡(markdown 组件),否则纯 text。
  // budget refusal/quick_reply/正式 handleReply/deliverTrusted 四条路径都只许走这里。
  async function deliverText(sessionKey, text, { idempotencyKey = randomUUID(), signal = null, atomic = false } = {}) {
    if (signal?.aborted) throw signal.reason ?? new Error("delivery aborted");
    const parsed = parseSessionKey(sessionKey);
    // debug 会话（web 调试台）：不真发 lark，落库即"出站"（前端轮询 transcript 显示）
    if (parsed.kind === "debug") return { messageId: null };
    const targetArg = parsed.kind === "p2p" ? { openId: parsed.openId }
      : parsed.kind === "group" ? { chatId: parsed.chatId } : null;
    if (!targetArg) throw new Error(`会话不可出站: ${sessionKey}`);
    if (hasRichMarkdown(text)) {
      // 物理发送一旦开始便等待真实回执；不能用 Promise.race 提前放行，否则底层晚成功时
      // daemon 可能再补一条 fallback。signal 只允许 outbound 在下一次 attempt 前停止。
      return outbound.sendCard({ ...targetArg, cardJson: buildMarkdownMessageCard({ md: text }), idempotencyKey, signal });
    }
    // 空行即拆分(用户定案 2026-07-12):纯文本消息里绝不带空行——按空段切成多条顺序发。
    // 卡片豁免(上面已 return):markdown 的空行是结构必需。幂等 key 按段派生,重试安全。
    // 注意:全空白文本原样交给 outbound 判错(text 必填),不在这里吞。
    const segs = String(text).split(/\n[ \t]*\n+/).map((s) => s.trim()).filter(Boolean);
    const parts = segs.length ? segs : [text];
    // atomic 终态投递:多段纯文本顺序发有"部分送达"窗口(前段成功后段失败,半截正式回复
    // 已见用户但回执缺失)。final/安全兜底场景改为单张 markdown 卡片,一次成败。
    if (atomic && parts.length > 1) {
      return outbound.sendCard({
        ...targetArg,
        cardJson: buildMarkdownMessageCard({ md: text }),
        idempotencyKey,
        signal,
      });
    }
    let last = null;
    for (let i = 0; i < parts.length; i++) {
      if (signal?.aborted) throw signal.reason ?? new Error("delivery aborted");
      last = await outbound.sendMessage({
        ...targetArg,
        text: parts[i],
        idempotencyKey: parts.length === 1 ? idempotencyKey : `${idempotencyKey}-p${i}`,
        signal,
      });
    }
    return last;
  }

  function appendAssistantAfterDelivery(sessionId, { content, messageId, source }) {
    try {
      store.append(sessionId, {
        role: "assistant",
        content,
        platformMessageId: messageId,
        ts: Date.now(),
      });
      return true;
    } catch (error) {
      log(`[turn] 已出站但 transcript 落库失败 source=${source} messageId=${messageId}: ${error?.message ?? error}`);
      onEvent({ type: "delivered_transcript_append_failed", source, messageId });
      return false;
    }
  }

  // 终态投递唯一序列（daemon fallback / egress 安全兜底 / 正式回复三处共用，顺序不可重排）：
  //   物理出站 → 注册表原子「记录投递+终态化 receipt」 → business_turn_terminal 事件
  //   （仅当本次调用真的终态化了 receipt）→ transcript 落库。
  // admission 与 daemonRef 互斥选择记录通道；两者都缺（无注册表的降级拓扑）时退化为
  // deliverText + append 两步。recordFailure 是调用方专属错误文案——物理消息已出站而
  // 注册表拒绝提交时必须 fail-loud，不得伪造回执；daemon 路径不 throw（传 null），
  // 由调用方按 recordedOk 发 brain_turn_delivery_record_failed。
  async function deliverTerminal({
    deliverKey,
    sessionId,
    text,
    stage = "final",
    source,
    appendSource = source,
    admission = null,
    daemonRef = null,
    idempotencyKey = undefined,
    signal = null,
    atomic = false,
    recordFailure = null,
  }) {
    const opts = { signal, atomic };
    if (idempotencyKey !== undefined) opts.idempotencyKey = idempotencyKey;
    const { messageId } = await deliverText(deliverKey, text, opts);
    let recorded = { ok: true, receipt: null };
    if (activeBrainTurns && admission) {
      recorded = activeBrainTurns.recordDelivery(admission, { stage, source, messageId });
    } else if (activeBrainTurns && daemonRef) {
      recorded = activeBrainTurns.recordDaemonDelivery(daemonRef, { messageId });
    }
    if (!recorded.ok && recordFailure) throw new Error(recordFailure);
    if (recorded.receipt) {
      onEvent({
        type: "business_turn_terminal",
        sessionKey: recorded.receipt.sessionKey,
        turnId: recorded.receipt.turnId,
        outcome: recorded.receipt.terminal?.outcome ?? null,
        messageId,
      });
    }
    appendAssistantAfterDelivery(sessionId, { content: text, messageId, source: appendSource });
    return { messageId, receipt: recorded.receipt, recordedOk: recorded.ok };
  }

  // handleReply / renderAutomationReply 共享的渲染核心：session 取用、近期语义拼装、
  // 投递场景判定、respond 渲染、budget 记账一份实现。egress 裁决与投递由调用方按各自
  // 策略（admission/安全兜底 vs 直拒）完成。
  async function renderCandidate({ sessionKey, deliverKey, brief, kind, tone = null, signal = null }) {
    const session = store.getOrCreate(sessionKey);
    // C3.2/P0:近期语义只用 promptRecent allowlist，历史行走统一 helper;
    // 排除 system——压缩摘要不得以 [用户] 身份泄入 reply 上下文
    const recent = store.promptRecent(session.id, { limit: 20, roles: ["user", "assistant", "tool"] })
      .map(formatHistoryLine).join("\n");
    const snapshot = snapshotFn ? snapshotFn({ sessionKey }) : null;
    // Task 10 C4:投递场景由 deliverKey(裁决后的真实去向)决定,群短平快/私聊展开
    let deliverKind = "p2p";
    try { if (parseSessionKey(deliverKey).kind === "group") deliverKind = "group"; } catch { /* debug 等按 p2p */ }
    const rendered = await abortable(renderReply({
      caller, soul: snapshot?.soul ?? soul, context: recent, brief, kind, tone, deliverKind,
    }), signal);
    if (rendered.usage) budget.record(sessionKey, rendered.usage);
    return { session, rendered };
  }

  // 5.5 reply 工具经内部 HTTP 到这里：admission → 渲染（respond 链）→ 出站/回卡片文案 → 落库 → 记账
  async function handleReply({
    sessionKey,
    kind = "message",
    stage = "final",
    brief,
    tone,
    target,
    turnId = null,
    turnLease = null,
    residentEpoch = null,
    taskId = null,
    runId = null,
    residentKey = null,
  }) {
    let replyAdmission = null;
    let admissionSignal = null;
    try {
      if (!brief?.trim()) return { ok: false, error: "brief 必填" };
      if (stage !== "progress" && stage !== "final") {
        return { ok: false, error: "stage 必须是 progress 或 final" };
      }
      if (activeBrainTurns) {
        const admitted = activeBrainTurns.admit({
          sessionKey,
          turnId,
          lease: turnLease,
          residentEpoch,
          taskId,
          executionKey: residentKey,
        });
        if (!admitted.ok) {
          onEvent({
            type: "reply_turn_rejected",
            sessionKey,
            turnId,
            code: admitted.code,
          });
          const detail = admitted.code === "maintenance_silent"
            ? "memory maintenance 必须静默"
            : admitted.code === "no_active_turn"
              ? "no active turn"
              : admitted.code === "turn_closing"
                ? "active turn 已关闭 admission"
                : "active turn context 不匹配";
          return { ok: false, code: admitted.code, error: `reply 拒绝: ${detail}` };
        }
        replyAdmission = admitted;
        admissionSignal = activeBrainTurns.admissionSignal?.(replyAdmission) ?? null;
      }
      // C0.4：render 之前先裁决投递目标——未 grant 的跨会话 target 一律拒绝,零渲染零出站
      const deliverKey = target ?? sessionKey;
      if (deliverKey !== sessionKey && !grants?.allowed(sessionKey, deliverKey)) {
        onEvent({ type: "reply_target_rejected", sessionKey, target: deliverKey });
        return { ok: false, error: `reply.target 越权：本会话未被授权向 ${deliverKey} 投递（跨会话请走 propose_actions 确认流）` };
      }
      // Batch C pre-render boundary. The session lifecycle registry is authoritative;
      // target/model supplied values never grant an egress capability.
      const pre = egress.preRender({
        sessionKey,
        taskId,
        residentKey,
        residentEpoch,
        deliverKey,
        brief,
        kind,
      });
      if (!pre.ok) {
        onEvent({ type: "reply_egress_rejected", sessionKey, phase: "pre_render", code: pre.code, audit: pre.audit });
        return { ok: false, error: `reply egress 拒绝: ${pre.code}` };
      }
      const { session, rendered } = await renderCandidate({
        sessionKey, deliverKey, brief, kind, tone, signal: admissionSignal,
      });
      const post = egress.postRender({
        sessionKey,
        taskId,
        residentKey,
        residentEpoch,
        provenance: pre.provenance,
        deliverKey,
        text: rendered.text,
        modelHash: rendered.modelHash ?? rendered.model_hash ?? null,
      });
      if (post.audit.modelHashMismatch) {
        onEvent({ type: "reply_model_hash_mismatch", sessionKey, audit: post.audit });
      }
      if (!post.ok) {
        onEvent({ type: "reply_egress_rejected", sessionKey, phase: "post_render", code: post.code, audit: post.audit });
        // A recycled resident or invalid target is not allowed to address the old audience,
        // even with a fixed fallback. card_copy likewise never returns unsafe model text.
        if (kind === "card_copy" || post.code === "stale_resident") return { ok: false, error: `reply egress 拒绝: ${post.code}`, text: SAFE_REPLY_FALLBACK };
        if (activeBrainTurns && !activeBrainTurns.reserveDelivery(replyAdmission, {
          stage: "final",
          source: "egress_safe_fallback",
        })) {
          return { ok: false, error: "reply egress 拒绝: terminal reply 已在发送或已完成" };
        }
        const { messageId } = await deliverTerminal({
          deliverKey,
          sessionId: session.id,
          text: SAFE_REPLY_FALLBACK,
          source: "egress_safe_fallback",
          admission: replyAdmission,
          signal: admissionSignal,
          atomic: true,
          recordFailure: "安全 fallback 物理发送后回执提交失败",
        });
        onEvent({ type: "reply_egress_fallback", sessionKey, messageId, code: post.code, audit: post.audit });
        return { ok: false, error: `reply egress 拒绝: ${post.code}`, text: SAFE_REPLY_FALLBACK, message_id: messageId };
      }
      if (kind === "card_copy") return { ok: true, text: rendered.text, audit: post.audit };

      // post 裁决与首次物理发送之间没有任何 await，post 在发送时刻仍然有效——
      // 若将来在这中间插入异步步骤，需在发送前重做（廉价的）epoch/registry 校验。
      if (activeBrainTurns && !activeBrainTurns.reserveDelivery(replyAdmission, {
        stage,
        source: "rendered_reply",
      })) {
        return { ok: false, error: stage === "final" ? "reply 拒绝: terminal reply 已在发送或已完成" : "reply 拒绝: delivery reservation 失败" };
      }
      const { messageId } = await deliverTerminal({
        deliverKey,
        sessionId: session.id,
        text: rendered.text,
        stage,
        source: "rendered_reply",
        appendSource: stage === "final" ? "formal_reply_sent" : "progress_reply_sent",
        admission: replyAdmission,
        signal: admissionSignal,
        atomic: stage === "final",
        recordFailure: "reply 物理发送后回执提交失败",
      });
      // C3.4 跨目标回写:目标会话自己的窗口里必须有这条投递(带 meta,不许造 chat_id=null 的群 session)。
      // 只 append assistant 记录,不触发 ambient limiter——跨会话授权已由 grants 承担。
      if (deliverKey !== sessionKey) {
        const p = parseSessionKey(deliverKey);
        if (p.kind === "group" || p.kind === "p2p") {
          try {
            const targetSession = store.getOrCreate(deliverKey, { kind: p.kind, chatId: p.kind === "group" ? p.chatId : null });
            appendAssistantAfterDelivery(targetSession.id, {
              content: rendered.text,
              messageId,
              source: "cross_target_transcript",
            });
          } catch (error) {
            log(`[turn] 已跨会话出站但目标 transcript 初始化失败 target=${deliverKey}: ${error?.message ?? error}`);
          }
        }
      }
      onEvent({
        type: "reply_sent",
        sessionKey,
        taskId,
        runId,
        residentKey,
        turnId: replyAdmission?.turnId ?? turnId ?? null,
        stage,
        source: "rendered_reply",
        messageId,
        audit: post.audit,
      });
      return { ok: true, text: rendered.text, message_id: messageId, audit: post.audit };
    } finally {
      if (replyAdmission) activeBrainTurns?.release(replyAdmission);
    }
  }

  // daemon-only 自动化渲染：不接受 Pi HTTP 请求、不参与 resident turn receipt，
  // 但保留 respond 渲染、post-render DLP 和唯一物理出口（零 registry 的参数化调用）。
  async function renderAutomationReply({ sessionKey, brief, tone = null }) {
    if (!brief?.trim()) return { ok: false, error: "brief 必填" };
    const pre = automationEgress.preRender({ sessionKey, deliverKey: sessionKey, brief, kind: "message" });
    if (!pre.ok) return { ok: false, error: `automation reply 拒绝: ${pre.code}` };
    const { session, rendered } = await renderCandidate({
      sessionKey, deliverKey: sessionKey, brief, kind: "message", tone,
    });
    const post = automationEgress.postRender({ deliverKey: sessionKey, text: rendered.text });
    if (!post.ok) return { ok: false, error: `automation reply 拒绝: ${post.code}` };
    const { messageId } = await deliverText(sessionKey, rendered.text);
    appendAssistantAfterDelivery(session.id, { content: rendered.text, messageId, source: "daemon_automation" });
    onEvent({ type: "automation_reply_sent", sessionKey, source: "daemon_automation", messageId });
    return { ok: true, text: rendered.text, message_id: messageId };
  }

  // daemon-only 受信直投（heartbeat 等确定性提醒）：不经 LLM 渲染,文案固定 `提醒：${text}`,
  // 出站后回写目标会话 transcript。只在进程内被 daemon 调用,绝不挂到内部 HTTP 通道。
  async function deliverTrusted({ deliverKey, text, idempotencyKey }) {
    if (!text?.trim()) return { ok: false, error: "text 必填" };
    const parsed = parseSessionKey(deliverKey);
    if (parsed.kind !== "p2p" && parsed.kind !== "group" && parsed.kind !== "debug") {
      return { ok: false, error: `不可投递的会话: ${deliverKey}` };
    }
    const message = `提醒：${text}`;
    const session = store.getOrCreate(deliverKey, { kind: parsed.kind, chatId: parsed.chatId ?? null });
    const { messageId } = await deliverText(deliverKey, message, { idempotencyKey });
    appendAssistantAfterDelivery(session.id, { content: message, messageId, source: "trusted_delivered" });
    onEvent({ type: "trusted_delivered", sessionKey: deliverKey, messageId });
    return { ok: true, message_id: messageId };
  }

  return {
    deliverText,
    deliverTerminal,
    handleReply,
    renderAutomationReply,
    deliverTrusted,
    appendAssistantAfterDelivery,
  };
}

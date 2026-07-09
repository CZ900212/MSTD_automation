import { randomUUID } from "node:crypto";
import { parseSessionKey } from "../sessions/session-key.mjs";
import { shouldNudge, NUDGE_NOTE } from "../memory/compact.mjs";

// 回合执行器：triage 四选一 → quick_reply 直出 / no_reply 落 observed / steer 注入 / escalate 走 brain。
// 结构性强制：brain 的 finalText 永不出站；5.5 只能经 reply 工具（handleReply）表达。

const BUDGET_REFUSAL = "今天的对话额度已用完，暂时无法继续处理。请稍后再试或联系管理员调整额度。";

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
  caller = null,              // 供 renderReply 使用（renderReply 已柯里化时可为 null）
  onEvent = () => {},         // 回合事件（SSE/调试台接缝）
  log = console.error,
} = {}) {
  function appendItems(sessionId, items, { observed = false } = {}) {
    for (const it of items) {
      store.append(sessionId, {
        role: "user",
        senderOpenId: it.senderOpenId ?? null,
        senderName: it.senderName ?? null,
        content: it.content,
        observed,
        platformMessageId: it.platformMessageId ?? null,
        ts: it.ts,
      });
    }
  }

  function renderContext(items) {
    return items.map((it) => `[${it.senderName ?? it.senderOpenId ?? "用户"}]: ${it.content}`).join("\n");
  }

  async function sendToSession(sessionKey, text) {
    const parsed = parseSessionKey(sessionKey);
    const idempotencyKey = randomUUID();
    if (parsed.kind === "p2p") return outbound.sendMessage({ openId: parsed.openId, text, idempotencyKey });
    if (parsed.kind === "group") return outbound.sendMessage({ chatId: parsed.chatId, text, idempotencyKey });
    // debug 会话（web 调试台）：不真发 lark，落库即"出站"（前端轮询 transcript 显示）
    if (parsed.kind === "debug") return { messageId: null };
    throw new Error(`会话不可出站: ${sessionKey}`);
  }

  async function handleTurn(turn) {
    const { kind, session, sessionKey, items, mode } = turn;
    if (kind !== "message") {
      // card_action / minutes：Phase D/E 接缝
      return onEvent({ type: "unhandled_kind", kind, turn });
    }

    if (!budget.allow(sessionKey).ok) {
      appendItems(session.id, items);
      const { messageId } = await sendToSession(sessionKey, BUDGET_REFUSAL);
      store.append(session.id, { role: "assistant", content: BUDGET_REFUSAL, platformMessageId: messageId, ts: Date.now() });
      return;
    }

    // 门控第 0 层（规则）：ambient 先过限额，不过直接 observed 落库（零模型成本）
    if (mode === "ambient" && limiter && session.chat_id && !limiter.allow(session.chat_id, Date.now())) {
      appendItems(session.id, items, { observed: true });
      onEvent({ type: "rate_limited", sessionKey });
      return;
    }

    const snapshot = snapshotFn ? snapshotFn({ sessionKey }) : null;
    const verdict = await triage.triage({ session, items, mode, snapshot, brainBusy: brain.isBusy(sessionKey) });
    onEvent({ type: "triage", sessionKey, verdict });

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
      onEvent({ type: "observe_only", sessionKey, verdict });
      return;
    }

    if (verdict.action === "no_reply") {
      appendItems(session.id, items, { observed: true });
      return;
    }

    if (verdict.action === "steer" && brain.isBusy(sessionKey)) {
      appendItems(session.id, items);
      brain.steer(sessionKey, verdict.note ?? renderContext(items));
      return;
    }

    appendItems(session.id, items);

    if (verdict.action === "quick_reply") {
      const { messageId } = await sendToSession(sessionKey, verdict.text);
      store.append(session.id, { role: "assistant", content: verdict.text, platformMessageId: messageId, ts: Date.now() });
      journal?.recordTurn({ sessionKey, sessionTitle: session.title, items, replyText: verdict.text });
      return;
    }

    // escalate（或 steer 但中枢已空闲 → 当 escalate 跑）
    let brief = verdict.brief ?? verdict.note ?? renderContext(items);
    // 群@ pending 窗口：把自上次发言以来的旁听消息注入一次（注入即消费）
    let context = renderContext(items);
    if (mode === "addressed" && sessionKey.startsWith("feishu:group:")) {
      const pending = store.recentObserved(session.id);
      if (pending.length) {
        const block = pending.map((m) => `[${m.sender_name ?? m.sender_open_id ?? "群成员"}]: ${m.content}`).join("\n");
        context = `[自你上次发言以来的群消息-仅供上下文]\n${block}\n[/上下文]\n\n${context}`;
        store.markObservedConsumed(pending.map((m) => m.id));
      }
    }
    try {
      if (compactor) await compactor.maybeCompact({ session, sessionKey, brain, snapshot });
      if (shouldNudge(store.transcript(session.id, { limit: 1000 }))) brief += `\n\n${NUDGE_NOTE}`;
      const result = await brain.turn({ session, sessionKey, brief, context, snapshot });
      for (const e of result.events ?? []) onEvent({ type: "brain_event", sessionKey, event: e });
      // finalText 只落库为内部记录（role=tool），绝不出站
      if (result.finalText) {
        store.append(session.id, { role: "tool", content: `[中枢内部结论] ${result.finalText.slice(0, 2000)}`, ts: Date.now() });
      }
      journal?.recordTurn({ sessionKey, sessionTitle: session.title, items, replyText: "" });
    } catch (e) {
      log(`[turn] brain 回合失败 session=${sessionKey}: ${e?.message ?? e}`);
      onEvent({ type: "brain_error", sessionKey, error: String(e?.message ?? e) });
    }
  }

  // 5.5 reply 工具经内部 HTTP 到这里：渲染（Opus respond 链）→ 出站/回卡片文案 → 落库 → 记账
  async function handleReply({ sessionKey, kind = "message", brief, tone, target }) {
    if (!brief?.trim()) return { ok: false, error: "brief 必填" };
    const session = store.getOrCreate(sessionKey);
    const recent = store.transcript(session.id, { limit: 20 })
      .map((m) => `[${m.role === "assistant" ? "我" : m.sender_name ?? m.sender_open_id ?? "用户"}]: ${m.content}`)
      .join("\n");
    const snapshot = snapshotFn ? snapshotFn({ sessionKey }) : null;
    const rendered = await renderReply({
      caller, soul: snapshot?.soul ?? soul, context: recent, brief, kind, tone,
    });
    if (rendered.usage) budget.record(sessionKey, rendered.usage);
    if (kind === "card_copy") return { ok: true, text: rendered.text };

    const deliverKey = target ?? sessionKey;
    const { messageId } = await sendToSession(deliverKey, rendered.text);
    store.append(session.id, { role: "assistant", content: rendered.text, platformMessageId: messageId, ts: Date.now() });
    onEvent({ type: "reply_sent", sessionKey, messageId });
    return { ok: true, text: rendered.text, message_id: messageId };
  }

  return { handleTurn, handleReply };
}

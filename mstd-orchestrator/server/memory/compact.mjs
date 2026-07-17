// 上下文压缩：token 超阈值 → 先 memory flush 回合 → 早期回合摘要化（reason 链）保留近 N 条原文。
// nudge 判定在 store.peekMemoryNudge/claimMemoryNudge（持久 watermark），本文件只出 NUDGE_NOTE 文案。
import { formatHistoryLine } from "../sessions/history-format.mjs";

export const estimateTokens = (transcript) =>
  Math.ceil(transcript.reduce((n, m) => n + (m.content?.length ?? 0), 0) / 2);

export const shouldCompact = (transcriptTokens, threshold) => transcriptTokens > threshold;

// C3.5:nudge 作为独立的静默维护回合执行，绝不混入业务 brief。
export const NUDGE_MAINTENANCE_BRIEF =
  "【系统维护回合】已累积较多对话。请检查是否有值得长期记住的事实/偏好/决定，用 memory 工具整理（新增/更新/淘汰）。不要给用户发任何消息（不要调用 reply）。";

const FLUSH_BRIEF =
  "【系统维护回合】会话即将压缩。请把本会话中值得长期记住的信息（事实/偏好/决定/未完成事项）用 memory 工具写入对应记忆层。不要给用户发任何消息（不要调用 reply）。";

export function createCompactor({ caller, store, thresholdTokens = 60_000, keepRecent = 20, log = console.error }) {
  if (typeof store?.memoryTranscript !== "function") {
    throw new Error("createCompactor: store.memoryTranscript 安全接口必填");
  }
  if (typeof store?.compactMessages !== "function") {
    throw new Error("createCompactor: store.compactMessages 原子接口必填");
  }
  // 会话级单飞：active 路径 maintenance 在 actor 队列外触发，同会话并行压缩会产出
  // 永久重复摘要污染每次重放。in-flight 期间的重复触发直接跳过（下回合自然重试）。
  const inFlight = new Set();

  async function maybeCompact({ session, sessionKey, brain, snapshot = null }) {
    if (inFlight.has(session.id)) return { compacted: false, reason: "in_flight" };
    inFlight.add(session.id);
    try {
      return await compactOnce({ session, sessionKey, brain, snapshot });
    } finally {
      inFlight.delete(session.id);
    }
  }

  async function compactOnce({ session, sessionKey, brain, snapshot }) {
    const transcript = store.memoryTranscript(session.id, { limit: 1000 });
    const compactable = transcript.filter((m) => m.role !== "system");
    if (!shouldCompact(estimateTokens(compactable), thresholdTokens)) return { compacted: false };
    if (compactable.length <= keepRecent) return { compacted: false };

    // ① flush 先行：让模型把要紧事写入记忆
    try {
      await brain.turn({
        session,
        sessionKey,
        purpose: "memory_maintenance",
        brief: FLUSH_BRIEF,
        snapshot,
      });
    } catch (e) {
      log(`[compact] flush 回合失败（继续压缩）: ${e?.message ?? e}`);
    }

    // ② 早期回合摘要化（reason 链），保留近 keepRecent 条原文;历史行走统一 helper(tool 不冒充用户)
    const early = compactable.slice(0, compactable.length - keepRecent);
    const earlyText = early.map(formatHistoryLine).join("\n");
    const out = await caller.call("reason", {
      system: "你是会话压缩器。把下面的对话历史压缩成要点摘要（保留人名、时间、决定、未决事项），200 字以内，直接输出摘要。",
      messages: [{ role: "user", content: earlyText }],
    });
    // 模型返回空串时删真留空 = 历史静默丢失；跳过本次压缩，下回合重试
    if (typeof out?.text !== "string" || !out.text.trim()) {
      log(`[compact] 摘要为空，跳过压缩 session=${sessionKey}`);
      return { compacted: false, reason: "empty_summary" };
    }

    // ③ 标记压缩点：软删 + 摘要插入同一事务（中途崩溃不丢历史）
    store.compactMessages(session.id, {
      messageIds: early.map((m) => m.id),
      summary: `〔压缩摘要〕${out.text}`,
      ts: (early[0]?.ts ?? 0),
    });
    return { compacted: true, summarized: early.length };
  }

  return { maybeCompact };
}

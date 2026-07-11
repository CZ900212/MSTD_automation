// 上下文压缩：token 超阈值 → 先 memory flush 回合 → 早期回合摘要化（reason 链）保留近 N 条原文。
// nudge 判定在 store.peekMemoryNudge/claimMemoryNudge（持久 watermark），本文件只出 NUDGE_NOTE 文案。
import { formatHistoryLine } from "../sessions/history-format.mjs";

export const estimateTokens = (transcript) =>
  Math.ceil(transcript.reduce((n, m) => n + (m.content?.length ?? 0), 0) / 2);

export const shouldCompact = (transcriptTokens, threshold) => transcriptTokens > threshold;

// C3.5:nudge 判定已迁 store.claimMemoryNudge(持久 watermark,重启不重复);
// 本文件只保留提示文案。
export const NUDGE_NOTE =
  "【系统提醒】已累积较多对话，请检查是否有值得长期记住的事实/偏好/决定，用 memory 工具整理（新增/更新/淘汰）。整理完继续正常回复，不必向用户提及。";

const FLUSH_BRIEF =
  "【系统维护回合】会话即将压缩。请把本会话中值得长期记住的信息（事实/偏好/决定/未完成事项）用 memory 工具写入对应记忆层。不要给用户发任何消息（不要调用 reply）。";

export function createCompactor({ caller, store, thresholdTokens = 60_000, keepRecent = 20, log = console.error }) {
  async function maybeCompact({ session, sessionKey, brain, snapshot = null }) {
    const transcript = store.transcript(session.id, { limit: 1000 });
    const compactable = transcript.filter((m) => m.role !== "system");
    if (!shouldCompact(estimateTokens(compactable), thresholdTokens)) return { compacted: false };
    if (compactable.length <= keepRecent) return { compacted: false };

    // ① flush 先行：让模型把要紧事写入记忆
    try {
      await brain.turn({ session, sessionKey, brief: FLUSH_BRIEF, snapshot });
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

    // ③ 标记压缩点：早期消息软删，摘要以 system 消息插入最前
    for (const m of early) store.softDelete(m.id);
    store.append(session.id, { role: "system", content: `〔压缩摘要〕${out.text}`, ts: (early[0]?.ts ?? 0) });
    return { compacted: true, summarized: early.length };
  }

  return { maybeCompact };
}

// 公司总日志：每个非 observed 回合结束追加一条要点（fast 链生成 + 写入时脱敏）。
// 失败不阻塞主回合（fire-and-forget + 日志）。
import { parseSessionKey } from "../sessions/session-key.mjs";

const SYSTEM = `你是公司日志记录员。把一次对话回合压缩成一句话要点（30 字内），第三人称，保留人名与关键结论。
必须脱敏：银行卡号/身份证/密码/密钥等敏感数据一律不写；私聊内容只记要点不记原文细节。直接输出要点，不加前缀。`;

export function createJournal({ caller, files, now = Date.now, log = console.error }) {
  function whereLabel(sessionKey, sessionTitle, senderName) {
    let parsed = null;
    try { parsed = parseSessionKey(sessionKey); } catch { /* 保底 */ }
    const who = senderName ?? "未知";
    if (parsed?.kind === "group") return `[${sessionTitle ?? parsed.chatId}·${who}]`;
    if (parsed?.kind === "p2p") return `[私聊·${who}]`;
    return `[${parsed?.kind ?? "系统"}]`;
  }

  async function recordTurn({ sessionKey, sessionTitle, items = [], replyText = "" }) {
    try {
      const convo = items.map((i) => `[${i.senderName ?? "用户"}]: ${i.content}`).join("\n")
        + (replyText ? `\n[助手]: ${replyText}` : "");
      const out = await caller.call("fast", {
        system: SYSTEM,
        messages: [{ role: "user", content: convo }],
      });
      const hhmm = new Intl.DateTimeFormat("zh-CN", {
        timeZone: "Asia/Shanghai", hour: "2-digit", minute: "2-digit", hour12: false,
      }).format(new Date(now()));
      const label = whereLabel(sessionKey, sessionTitle, items[0]?.senderName);
      files.appendJournal(`- ${hhmm} ${label} ${out.text.trim().replace(/\n+/g, " ")}`, now());
    } catch (e) {
      log(`[journal] 记录失败（不阻塞回合）: ${e?.message ?? e}`);
    }
  }

  return { recordTurn };
}

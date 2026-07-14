// 回合要点记录：群聊进入公司 journal；私聊只进入本人 user 层，绝不写全局日志。
// 失败不阻塞主回合（fire-and-forget + 日志）。
import { parseSessionKey } from "../sessions/session-key.mjs";
import { scanInjectionSignals } from "../safety/injection-signals.mjs";
import { redactSensitiveText, scanSensitiveText } from "../safety/sensitive-text.mjs";
import { USER_JOURNAL_MAX_CHARS } from "./files.mjs";

const SEP = "\n\n§ ";

function trimUserJournal(text, max = USER_JOURNAL_MAX_CHARS) {
  let out = text;
  while (out.length > max) {
    const first = out.indexOf(SEP);
    if (first < 0) return out.slice(0, max);
    out = out.slice(first + SEP.length);
  }
  return out;
}
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
      const parsed = parseSessionKey(sessionKey);
      // Only canonical Feishu conversations produce persistent summaries. Cron/debug
      // maintenance has its own state and must never fall through to company journal.
      if (parsed.kind !== "p2p" && parsed.kind !== "group") return;
      const rawConvo = items.map((i) => `[${i.senderName ?? "用户"}]: ${i.content}`).join("\n")
        + (replyText ? `\n[助手]: ${replyText}` : "");
      const convo = redactSensitiveText(rawConvo).text;
      const out = await caller.call("fast", {
        system: SYSTEM,
        messages: [{ role: "user", content: convo }],
      });
      const summary = typeof out?.text === "string" ? out.text.trim().replace(/\n+/g, " ") : "";
      if (!summary) return;
      const sensitive = scanSensitiveText(summary);
      const signals = scanInjectionSignals(summary);
      if (sensitive.length || signals.length) {
        throw new Error(`持久记忆安全门拒绝(sensitive=${sensitive.join(",") || "none"};signals=${signals.join(",") || "none"})`);
      }
      const at = now();

      if (parsed.kind === "p2p") {
        // 自动摘要与 memory 工具维护的 curated user memory 物理隔离；容量淘汰只作用于摘要文件。
        const { content, snapshotHash } = files.readUserJournal(parsed.openId);
        const stamped = `${summary} 〔来源:${sessionKey} 时间:${new Date(at).toISOString()}〕`;
        const appended = content ? `${content}${SEP}${stamped}` : stamped;
        files.writeUserJournal(parsed.openId, trimUserJournal(appended), { expectedHash: snapshotHash });
        return;
      }

      const hhmm = new Intl.DateTimeFormat("zh-CN", {
        timeZone: "Asia/Shanghai", hour: "2-digit", minute: "2-digit", hour12: false,
      }).format(new Date(at));
      const label = whereLabel(sessionKey, sessionTitle, items[0]?.senderName);
      files.appendJournal(`- ${hhmm} ${label} ${summary}`, at);
    } catch (e) {
      log(`[journal] 记录失败（不阻塞回合）: ${e?.message ?? e}`);
    }
  }

  return { recordTurn };
}

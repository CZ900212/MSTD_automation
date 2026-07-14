// 记忆注入器：会话启动时冻结快照（保 prompt 前缀缓存）。
// 隔离铁律：群会话 scoped=本群；私聊 scoped=本人；群 A / 私聊原文绝不进群 B。
import { parseSessionKey } from "../sessions/session-key.mjs";

export function buildMemorySnapshot({ files, sessionKey, now = Date.now() }) {
  const soul = files.readLayer("soul").content;
  const org = files.readLayer("org").content;
  // journal 是审计记录，不是任意会话可见的上下文；保留 journal 文件供受控读取与审计，不进入默认快照。
  const journalDigest = "";

  let scoped = "";
  let parsed = null;
  try { parsed = parseSessionKey(sessionKey); } catch { /* 未知会话不给 scoped */ }
  if (parsed?.kind === "group") scoped = files.readLayer("group", parsed.chatId).content;
  else if (parsed?.kind === "p2p") {
    const curated = files.readLayer("user", parsed.openId).content;
    const privateJournal = files.readUserJournal?.(parsed.openId).content ?? "";
    scoped = privateJournal
      ? [
        curated ? `## 人工维护记忆\n${curated}` : "",
        `## 近期私聊摘要\n${privateJournal}`,
      ].filter(Boolean).join("\n\n")
      : curated;
  }

  return Object.freeze({ soul, org, journalDigest, scoped, sessionKey, frozenAt: now });
}

// 记忆注入器：会话启动时冻结快照（保 prompt 前缀缓存）。
// 隔离铁律：群会话 scoped=本群；私聊 scoped=本人；群 A / 私聊原文绝不进群 B。
import { parseSessionKey } from "../sessions/session-key.mjs";

const JOURNAL_DIGEST_MAX = 1500;

export function buildMemorySnapshot({ files, sessionKey, now = Date.now() }) {
  const soul = files.readLayer("soul").content;
  const org = files.readLayer("org").content;
  const journal = files.readJournal(now);
  const journalDigest = journal.length > JOURNAL_DIGEST_MAX
    ? journal.slice(-JOURNAL_DIGEST_MAX)
    : journal;

  let scoped = "";
  let parsed = null;
  try { parsed = parseSessionKey(sessionKey); } catch { /* 未知会话不给 scoped */ }
  if (parsed?.kind === "group") scoped = files.readLayer("group", parsed.chatId).content;
  else if (parsed?.kind === "p2p") scoped = files.readLayer("user", parsed.openId).content;

  return Object.freeze({ soul, org, journalDigest, scoped, sessionKey, frozenAt: now });
}

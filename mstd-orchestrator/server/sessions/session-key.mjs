export function buildSessionKey({ kind, openId, chatId, topicId, jobId, debugId }) {
  switch (kind) {
    case "p2p":
      if (!openId) throw new Error("p2p 需要 openId");
      return `feishu:p2p:${openId}`;
    case "group":
      if (!chatId) throw new Error("group 需要 chatId");
      return topicId ? `feishu:group:${chatId}:${topicId}` : `feishu:group:${chatId}`;
    case "cron":
      if (!jobId) throw new Error("cron 需要 jobId");
      return `cron:${jobId}`;
    case "debug":
      if (!debugId) throw new Error("debug 需要 debugId");
      return `debug:${debugId}`;
    default:
      throw new Error(`未知会话类型: ${kind}`);
  }
}

// canonical round-trip：parse 后必须能原样重建（拒缺 id/多余段），且 kind 仅 p2p/group。
// 非法输入一律返回 null（fail-closed，不抛错）。heartbeat 队列与 schedule_reminder DSL 共用。
export function canonicalDeliverableKey(key) {
  if (typeof key !== "string" || !key) return null;
  let parsed;
  try { parsed = parseSessionKey(key); } catch { return null; }
  if (parsed.kind !== "p2p" && parsed.kind !== "group") return null;
  let rebuilt;
  try { rebuilt = buildSessionKey(parsed); } catch { return null; }
  return rebuilt === key ? key : null;
}

export function parseSessionKey(key) {
  const parts = key.split(":");
  if (parts[0] === "cron") return { kind: "cron", jobId: parts[1] };
  if (parts[0] === "debug") return { kind: "debug", debugId: parts[1] };
  if (parts[0] === "feishu" && parts[1] === "p2p") return { kind: "p2p", openId: parts[2] };
  if (parts[0] === "feishu" && parts[1] === "group") {
    const out = { kind: "group", chatId: parts[2] };
    if (parts[3]) out.topicId = parts[3];
    return out;
  }
  throw new Error(`无法解析会话键: ${key}`);
}

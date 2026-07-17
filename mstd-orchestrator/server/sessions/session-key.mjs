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
  if (typeof key !== "string" || !key) throw new Error(`无法解析会话键: ${key}`);
  const parts = key.split(":");
  let parsed;
  if (parts.length === 2 && parts[0] === "cron" && parts[1]) {
    parsed = { kind: "cron", jobId: parts[1] };
  } else if (parts.length === 2 && parts[0] === "debug" && parts[1]) {
    parsed = { kind: "debug", debugId: parts[1] };
  } else if (parts.length === 3 && parts[0] === "feishu" && parts[1] === "p2p" && parts[2]) {
    parsed = { kind: "p2p", openId: parts[2] };
  } else if (
    (parts.length === 3 || parts.length === 4)
    && parts[0] === "feishu"
    && parts[1] === "group"
    && parts[2]
    && (parts.length === 3 || parts[3])
  ) {
    parsed = {
      kind: "group",
      chatId: parts[2],
      ...(parts.length === 4 ? { topicId: parts[3] } : {}),
    };
  } else {
    throw new Error(`无法解析会话键: ${key}`);
  }
  if (buildSessionKey(parsed) !== key) throw new Error(`无法解析会话键: ${key}`);
  return parsed;
}

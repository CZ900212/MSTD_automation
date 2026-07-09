import { createHash } from "node:crypto";

export function createInbox(db, { botOpenId }) {
  function normalize(raw) {
    // lark-cli event consume 输出扁平形状（真机验证）：{type, event_id, message_id, chat_id, chat_type, sender_id, content, mentions?}
    if (raw?.type && !raw?.header) return normalizeFlat(raw);
    const type = raw?.header?.event_type;
    if (type === "im.message.receive_v1") {
      const m = raw.event.message;
      let text = "";
      try { text = JSON.parse(m.content).text ?? ""; } catch { return null; }
      const mentions = m.mentions ?? [];
      return {
        eventId: raw.header.event_id,
        kind: "message",
        chatId: m.chat_id,
        chatType: m.chat_type,                    // p2p | group
        senderOpenId: raw.event.sender.sender_id?.open_id ?? null,
        senderType: raw.event.sender.sender_type ?? "user",   // user | app（bot 消息无 open_id）
        senderName: raw.event.sender.sender_id?.name ?? null,
        content: text,
        mentionsBot: mentions.some((x) => x?.id?.open_id === botOpenId),
        topicId: m.thread_id ?? null,
        ts: Number(m.create_time),
      };
    }
    if (type === "card.action.trigger") {
      return { eventId: raw.header.event_id, kind: "card_action", raw: raw.event, ts: Date.now() };
    }
    if (type?.startsWith("minutes.")) {
      return { eventId: raw.header.event_id, kind: "minutes", raw: raw.event, ts: Date.now() };
    }
    return null;
  }

  function normalizeFlat(raw) {
    if (raw.type === "im.message.receive_v1") {
      if (raw.message_type && raw.message_type !== "text") return null; // 非文本先不进管道
      const mentions = raw.mentions ?? [];
      const mentionIds = mentions.map((m) => (typeof m === "string" ? m : m?.id?.open_id ?? m?.open_id ?? m?.id)).filter(Boolean);
      return {
        eventId: raw.event_id,
        kind: "message",
        chatId: raw.chat_id,
        chatType: raw.chat_type,
        senderOpenId: raw.sender_id ?? null,
        senderType: raw.sender_type ?? (raw.sender_id ? "user" : "app"),
        senderName: raw.sender_name ?? null,
        content: typeof raw.content === "string" ? raw.content : "",
        mentionsBot: mentionIds.includes(botOpenId),
        topicId: raw.thread_id ?? null,
        ts: Number(raw.create_time ?? raw.timestamp ?? Date.now()),
      };
    }
    if (raw.type === "card.action.trigger") {
      return { eventId: raw.event_id, kind: "card_action", raw, ts: Number(raw.timestamp ?? Date.now()) };
    }
    if (raw.type?.startsWith("minutes.")) {
      return { eventId: raw.event_id, kind: "minutes", raw, ts: Number(raw.timestamp ?? Date.now()) };
    }
    return null;
  }

  const md5 = (evt) => createHash("md5")
    .update(`${evt.chatId ?? ""}|${evt.senderOpenId ?? ""}|${evt.content ?? ""}`).digest("hex");

  function isDuplicate(evt, now = Date.now()) {
    if (db.prepare("SELECT 1 FROM inbox_events WHERE event_id = ?").get(evt.eventId)) return true;
    if (evt.kind !== "message") return false;
    return !!db.prepare(
      "SELECT 1 FROM inbox_events WHERE chat_id = ? AND content_md5 = ? AND ts > ?"
    ).get(evt.chatId, md5(evt), now - 60_000);
  }

  function markSeen(evt, now = Date.now()) {
    db.prepare(
      "INSERT INTO inbox_events (event_id, chat_id, content_md5, ts) VALUES (?, ?, ?, ?) ON CONFLICT (event_id) DO NOTHING"
    ).run(evt.eventId, evt.chatId ?? null, evt.kind === "message" ? md5(evt) : null, now);
  }

  function recordVerdict(eventId, verdict) {
    db.prepare("UPDATE inbox_events SET verdict = ? WHERE event_id = ?").run(JSON.stringify(verdict), eventId);
  }

  return { normalize, isDuplicate, markSeen, recordVerdict };
}

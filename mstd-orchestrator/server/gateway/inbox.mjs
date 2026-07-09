import { createHash } from "node:crypto";

export function createInbox(db, { botOpenId }) {
  function normalize(raw) {
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
        senderOpenId: raw.event.sender.sender_id.open_id,
        senderName: raw.event.sender.sender_id.name ?? null,
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

  return { normalize, isDuplicate, markSeen };
}

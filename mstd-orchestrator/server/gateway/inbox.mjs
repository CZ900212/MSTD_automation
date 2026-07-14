import { createHash } from "node:crypto";
import { normalizeIncoming } from "./normalize.mjs";

export function createInbox(db, { botOpenId, botName = "", botNames = null, normalizer = normalizeIncoming, log = console.error }) {
  const names = botNames ?? (botName ? [botName] : []);
  const inboxCols = new Set(db.prepare("PRAGMA table_info(inbox_events)").all().map((c) => c.name));
  const hasPlatformCols = inboxCols.has("platform_message_id");

  // C2：mention 检测与文本替换同源（normalize.mjs 单趟 replace）。
  // normalizer 异常时 content 回退原文，mentionsBot 只信结构化 bot open_id——
  // 无边界 substring 判定已退役，禁止回加。
  function normalizeContent(rawText, mentions) {
    const list = Array.isArray(mentions) ? mentions : [];
    const structuredBot = list.some(
      (m) => (typeof m === "string" ? m : m?.id?.open_id ?? m?.open_id ?? m?.id) === botOpenId
    );
    try {
      const r = normalizer(rawText, {
        botNames: names,
        botOpenId,
        mentions: list.filter((m) => m && typeof m === "object"),
      });
      return { content: r.content, mentionsBot: structuredBot || !!r.mentionsBot };
    } catch (e) {
      log(`[inbox] normalizer 异常,content 回退原文: ${e?.message ?? e}`);
      return { content: rawText, mentionsBot: structuredBot };
    }
  }

  function normalize(raw) {
    // lark-cli event consume 输出扁平形状（真机验证）：{type, event_id, message_id, chat_id, chat_type, sender_id, content, mentions?}
    if (raw?.type && !raw?.header) return normalizeFlat(raw);
    const type = raw?.header?.event_type;
    if (type === "im.message.receive_v1") {
      const m = raw.event.message;
      let text = "";
      try { text = JSON.parse(m.content).text ?? ""; } catch { return null; }
      const mentions = m.mentions ?? [];
      const { content, mentionsBot } = normalizeContent(text, mentions);
      return {
        eventId: raw.header.event_id,
        kind: "message",
        chatId: m.chat_id,
        chatType: m.chat_type,                    // p2p | group
        senderOpenId: raw.event.sender.sender_id?.open_id ?? null,
        senderType: raw.event.sender.sender_type ?? "user",   // user | app（bot 消息无 open_id）
        senderAppId: raw.event.sender.sender_id?.app_id ?? raw.event.sender?.app_id ?? null,
        senderName: raw.event.sender.sender_id?.name ?? null,
        platformMessageId: m.message_id ?? null,
        source: "feishu",
        content,
        rawContent: text,
        mentionsBot,
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
      const text = typeof raw.content === "string" ? raw.content : "";
      // lark-cli 扁平事件通常把 mention 转写成 "@<bot名>" 纯文本且丢弃 mentions 字段（真机验证）；
      // 纯文本识别走 normalizer 的有边界 matcher，结构化 id（若有）作兜底
      const { content, mentionsBot } = normalizeContent(text, raw.mentions ?? []);
      return {
        eventId: raw.event_id,
        kind: "message",
        chatId: raw.chat_id,
        chatType: raw.chat_type,
        senderOpenId: raw.sender_id ?? null,
        senderType: raw.sender_type ?? (raw.sender_id ? "user" : "app"),
        senderAppId: raw.sender_app_id ?? raw.app_id ?? null,
        senderName: raw.sender_name ?? null,
        platformMessageId: raw.message_id ?? null,
        source: raw.source === "simulator" ? "simulator" : "feishu",
        content,
        rawContent: text,
        mentionsBot,
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

  // 去重指纹用规范化前原文 + 发送方身份：
  // - 身份键优先 open_id，否则 app_id（bot），再否则空串
  // - 不同 bot 同正文不得互判重；不同原文规范化塌缩后也不得误丢
  const senderIdentity = (evt) => evt.senderOpenId ?? evt.senderAppId ?? "";
  const md5 = (evt) => createHash("md5")
    .update(`${evt.chatId ?? ""}|${senderIdentity(evt)}|${evt.rawContent ?? evt.content ?? ""}`).digest("hex");

  function isDuplicate(evt, now = Date.now()) {
    if (db.prepare("SELECT 1 FROM inbox_events WHERE event_id = ?").get(evt.eventId)) return true;
    if (evt.kind !== "message") return false;
    return !!db.prepare(
      "SELECT 1 FROM inbox_events WHERE chat_id = ? AND content_md5 = ? AND ts > ?"
    ).get(evt.chatId, md5(evt), now - 60_000);
  }

  function markSeen(evt, now = Date.now(), { sensitive = false } = {}) {
    const raw = evt.kind === "message" ? evt.rawContent ?? "" : "";
    const rawSha256 = evt.kind === "message"
      ? createHash("sha256").update(raw).digest("hex")
      : null;
    if (hasPlatformCols) {
      db.prepare(
        `INSERT INTO inbox_events (event_id, chat_id, content_md5, raw_content, raw_sha256, ts,
           platform_message_id, sender_app_id, source)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT (event_id) DO NOTHING`
      ).run(
        evt.eventId,
        evt.chatId ?? null,
        evt.kind === "message" ? md5(evt) : null,
        evt.kind === "message" && !sensitive ? evt.rawContent ?? null : null,
        rawSha256,
        now,
        evt.platformMessageId ?? null,
        evt.senderAppId ?? null,
        evt.source ?? "feishu"
      );
    } else {
      db.prepare(
        `INSERT INTO inbox_events (event_id, chat_id, content_md5, raw_content, raw_sha256, ts)
         VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT (event_id) DO NOTHING`
      ).run(
        evt.eventId,
        evt.chatId ?? null,
        evt.kind === "message" ? md5(evt) : null,
        evt.kind === "message" && !sensitive ? evt.rawContent ?? null : null,
        rawSha256,
        now
      );
    }
  }

  function recordVerdict(eventId, verdict) {
    db.prepare("UPDATE inbox_events SET verdict = ? WHERE event_id = ?").run(JSON.stringify(verdict), eventId);
  }

  return { normalize, isDuplicate, markSeen, recordVerdict };
}

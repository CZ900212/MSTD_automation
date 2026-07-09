import { describe, it, expect } from "vitest";
import { openDb, migrate } from "../server/db/index.mjs";
import { createInbox } from "../server/gateway/inbox.mjs";

const freshDb = () => { const db = openDb(); migrate(db); return db; };

const rawMsg = (over = {}) => ({
  header: { event_id: over.eventId ?? "ev1", event_type: "im.message.receive_v1" },
  event: {
    sender: { sender_id: { open_id: "ou_a" } },
    message: {
      chat_id: "oc_1", chat_type: "group", message_type: "text",
      content: JSON.stringify({ text: over.text ?? "你好 @_user_1" }),
      mentions: over.mentions ?? [{ id: { open_id: "ou_bot" }, key: "@_user_1" }],
      create_time: "1720000000000",
    },
  },
});

describe("inbox", () => {
  it("归一化文本消息并识别 @bot", () => {
    const inbox = createInbox(freshDb(), { botOpenId: "ou_bot" });
    const evt = inbox.normalize(rawMsg());
    expect(evt).toMatchObject({
      eventId: "ev1", kind: "message", chatId: "oc_1", chatType: "group",
      senderOpenId: "ou_a", mentionsBot: true,
    });
  });
  it("event_id 去重 + 60s 内同 chat 同内容 MD5 去重", () => {
    const inbox = createInbox(freshDb(), { botOpenId: "ou_bot" });
    const e1 = inbox.normalize(rawMsg());
    expect(inbox.isDuplicate(e1, 1000)).toBe(false);
    inbox.markSeen(e1, 1000);
    expect(inbox.isDuplicate(e1, 2000)).toBe(true);                        // 同 event_id
    const e2 = inbox.normalize(rawMsg({ eventId: "ev2" }));
    expect(inbox.isDuplicate(e2, 30_000)).toBe(true);                      // 同内容 60s 窗口
    expect(inbox.isDuplicate(inbox.normalize(rawMsg({ eventId: "ev3" })), 120_000)).toBe(false);
  });
});

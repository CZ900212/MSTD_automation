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
  it("归一化 lark-cli 扁平事件（真机形状）", () => {
    const inbox = createInbox(freshDb(), { botOpenId: "ou_bot" });
    const evt = inbox.normalize({
      type: "im.message.receive_v1",
      event_id: "93f54e90",
      timestamp: "1783594348044",
      message_id: "om_x1",
      create_time: "1783594347617",
      chat_id: "oc_11b7",
      chat_type: "p2p",
      message_type: "text",
      sender_id: "ou_aca75",
      content: "事件形状探测",
    });
    expect(evt).toMatchObject({
      eventId: "93f54e90", kind: "message", chatId: "oc_11b7", chatType: "p2p",
      senderOpenId: "ou_aca75", senderType: "user", content: "事件形状探测",
      mentionsBot: false, ts: 1783594347617,
    });
    const group = inbox.normalize({
      type: "im.message.receive_v1", event_id: "e2", chat_id: "oc_2", chat_type: "group",
      message_type: "text", sender_id: "ou_x", content: "@bot 在吗", mentions: ["ou_bot"],
      create_time: "1000",
    });
    expect(group.mentionsBot).toBe(true);
  });

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

describe("inbox 扁平事件 @ 识别（mentions 字段被 lark-cli 丢弃）", () => {
  it("bot 名字文本匹配识别 @；无名字命中则不算", () => {
    const inbox = createInbox(freshDb(), { botOpenId: "ou_bot", botName: "小达助手" });
    const evt = inbox.normalize({
      type: "im.message.receive_v1", event_id: "m1", chat_id: "oc_1", chat_type: "group",
      message_type: "text", sender_id: "ou_a", content: "@小达助手 在吗", create_time: "1000",
    });
    expect(evt.mentionsBot).toBe(true);
    const evt2 = inbox.normalize({
      type: "im.message.receive_v1", event_id: "m2", chat_id: "oc_1", chat_type: "group",
      message_type: "text", sender_id: "ou_a", content: "随便聊聊", create_time: "1000",
    });
    expect(evt2.mentionsBot).toBe(false);
  });
});

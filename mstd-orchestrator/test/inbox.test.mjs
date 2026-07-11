import { describe, it, expect, vi } from "vitest";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { openDb, migrate } from "../server/db/index.mjs";
import { createInbox } from "../server/gateway/inbox.mjs";
import { normalizeIncoming } from "../server/gateway/normalize.mjs";

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

// ---- Task 5 C2: 入站单趟规范化(inbox 集成) ----
describe("inbox 入站规范化（Task 5 C2）", () => {
  const NAMES = ["user613148's Feishu CLI", "小达"];
  const flat = (over = {}) => ({
    type: "im.message.receive_v1", event_id: over.eventId ?? "n1", chat_id: "oc_1", chat_type: "group",
    message_type: "text", sender_id: "ou_a", content: over.content ?? "@user613148's Feishu CLI 复述一下", create_time: "1000",
    ...(over.mentions ? { mentions: over.mentions } : {}),
  });

  it("旧名文本事件：mentionsBot=true、content 规范成 [@我]、raw 原文落 inbox_events.raw_content", () => {
    const db = freshDb();
    const inbox = createInbox(db, { botOpenId: "ou_bot", botNames: NAMES });
    const evt = inbox.normalize(flat());
    expect(evt.mentionsBot).toBe(true);
    expect(evt.content).toBe("[@我] 复述一下");
    expect(evt.rawContent).toBe("@user613148's Feishu CLI 复述一下");
    inbox.markSeen(evt, 1000);
    expect(db.prepare("SELECT raw_content FROM inbox_events WHERE event_id = ?").get(evt.eventId).raw_content)
      .toBe("@user613148's Feishu CLI 复述一下");
  });

  it("@小达人 不算点名（无边界 substring 判定退役），不会被 admit 当 addressed", () => {
    const inbox = createInbox(freshDb(), { botOpenId: "ou_bot", botNames: NAMES });
    const evt = inbox.normalize(flat({ content: "@小达人 是谁" }));
    expect(evt.mentionsBot).toBe(false);
    expect(evt.content).toBe("@小达人 是谁");
  });

  it("normalizer 抛错：content 回退 raw、错误有日志、无 metadata 时 mentionsBot=false", () => {
    const logs = [];
    const inbox = createInbox(freshDb(), {
      botOpenId: "ou_bot", botNames: NAMES,
      normalizer: () => { throw new Error("normalizer boom"); },
      log: (m) => logs.push(String(m)),
    });
    const evt = inbox.normalize(flat({ content: "@小达 在吗" }));
    expect(evt.content).toBe("@小达 在吗");
    expect(evt.mentionsBot).toBe(false);
    expect(logs.some((l) => l.includes("boom"))).toBe(true);
  });

  it("normalizer 抛错但结构化 metadata 带 bot open_id：mentionsBot 仍为 true", () => {
    const inbox = createInbox(freshDb(), {
      botOpenId: "ou_bot", botNames: NAMES,
      normalizer: () => { throw new Error("boom"); }, log: () => {},
    });
    const evt = inbox.normalize(flat({ content: "@小达 在吗", mentions: ["ou_bot"] }));
    expect(evt.mentionsBot).toBe(true);
    expect(evt.content).toBe("@小达 在吗");
  });

  it("官方信封路径同样单趟规范化：结构化 bot mention 变 [@我]，raw 保留", () => {
    const inbox = createInbox(freshDb(), { botOpenId: "ou_bot", botNames: NAMES });
    const evt = inbox.normalize(rawMsg({
      text: "你好 @_user_1",
      mentions: [{ id: { open_id: "ou_bot" }, key: "@_user_1", name: "小达" }],
    }));
    expect(evt.content).toBe("你好 [@我]");
    expect(evt.rawContent).toBe("你好 @_user_1");
    expect(evt.mentionsBot).toBe(true);
  });

  // §5.1 审核仲裁冻结：官方路径打字型 @名（未选结构化 mention）也算点名——
  // P1 双名规范化语义,两路径同一有边界 matcher;局限已记 README
  it("官方信封路径纯文本 @小达（无结构化 mention）→ mentionsBot=true 且替换", () => {
    const inbox = createInbox(freshDb(), { botOpenId: "ou_bot", botNames: NAMES });
    const evt = inbox.normalize(rawMsg({ text: "手打 @小达 在么", mentions: [] }));
    expect(evt.content).toBe("手打 [@我] 在么");
    expect(evt.mentionsBot).toBe(true);
  });

  // §5.1 审核补杀：去重指纹基于原文——不同原文规范化塌缩成同一 content 不算重复
  it("md5 去重用 rawContent：纯文本 @ 与结构化 @ 塌缩同 content 时不互判重复", () => {
    const db = freshDb();
    const inbox = createInbox(db, { botOpenId: "ou_bot", botNames: NAMES });
    const plain = inbox.normalize(flat({ eventId: "d1", content: "@小达 hi" }));
    const structured = inbox.normalize(rawMsg({
      eventId: "d2", text: "@_user_1 hi",
      mentions: [{ id: { open_id: "ou_bot" }, key: "@_user_1", name: "小达" }],
    }));
    expect(plain.content).toBe(structured.content);                        // 双方均为 "[@我] hi"
    inbox.markSeen(plain, 1000);
    expect(inbox.isDuplicate(structured, 2000)).toBe(false);               // 原文不同,不判重
  });

  // ---- §5.2 审卷补杀 ----

  it("md5 指纹精确等于 md5(chat|sender|raw)；等长不同原文不判重", () => {
    const db = freshDb();
    const inbox = createInbox(db, { botOpenId: "ou_bot", botNames: NAMES });
    const raw = "@小达 hi1";
    const evt = inbox.normalize(flat({ eventId: "f1", content: raw }));
    inbox.markSeen(evt, 1000);
    const stored = db.prepare("SELECT content_md5 FROM inbox_events WHERE event_id = 'f1'").get().content_md5;
    expect(stored).toBe(createHash("md5").update(`oc_1|ou_a|${raw}`).digest("hex"));
    const sameLen = inbox.normalize(flat({ eventId: "f2", content: "@小达 hi2" }));   // 与 raw 等长
    expect(inbox.isDuplicate(sameLen, 2000)).toBe(false);
  });

  it("markSeen 落库的 raw 逐字节保真（首尾空白/tab 不丢）", () => {
    const db = freshDb();
    const inbox = createInbox(db, { botOpenId: "ou_bot", botNames: NAMES });
    const raw = "  @小达 在 \t ";
    const evt = inbox.normalize(flat({ eventId: "w1", content: raw }));
    inbox.markSeen(evt, 1000);
    expect(db.prepare("SELECT raw_content FROM inbox_events WHERE event_id = 'w1'").get().raw_content).toBe(raw);
  });

  it.each([
    ["裸字符串", "ou_bot"],
    ["官方 id.open_id", { id: { open_id: "ou_bot" } }],
    ["扁平 open_id", { open_id: "ou_bot" }],
    ["对象裸 id", { id: "ou_bot" }],
  ])("normalizer 抛错时四种 metadata 形状（%s）都判点名", (_l, mention) => {
    const inbox = createInbox(freshDb(), {
      botOpenId: "ou_bot", botNames: NAMES,
      normalizer: () => { throw new Error("boom"); }, log: () => {},
    });
    const evt = inbox.normalize(flat({ content: "@小达 在吗", mentions: [mention] }));
    expect(evt.mentionsBot).toBe(true);
    expect(evt.content).toBe("@小达 在吗");
  });

  it("官方信封路径 normalizer 抛错：raw 回退 + 结构化 metadata 仍判点名", () => {
    const logs = [];
    const inbox = createInbox(freshDb(), {
      botOpenId: "ou_bot", botNames: NAMES,
      normalizer: () => { throw new Error("official boom"); },
      log: (m) => logs.push(String(m)),
    });
    const evt = inbox.normalize(rawMsg({
      text: "你好 @_user_1",
      mentions: [{ id: { open_id: "ou_bot" }, key: "@_user_1", name: "小达" }],
    }));
    expect(evt.content).toBe("你好 @_user_1");
    expect(evt.mentionsBot).toBe(true);
    expect(logs.some((l) => l.includes("official boom"))).toBe(true);
  });

  it("两条路径各恰调一次 normalizer，参数完整", () => {
    const spy = vi.fn(normalizeIncoming);
    const inbox = createInbox(freshDb(), { botOpenId: "ou_bot", botNames: NAMES, normalizer: spy });
    inbox.normalize(flat({ content: "@小达 hi" }));
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy).toHaveBeenCalledWith("@小达 hi", { botNames: NAMES, botOpenId: "ou_bot", mentions: [] });
    spy.mockClear();
    inbox.normalize(rawMsg({ text: "你好 @_user_1", mentions: [{ id: { open_id: "ou_bot" }, key: "@_user_1", name: "小达" }] }));
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy).toHaveBeenCalledWith("你好 @_user_1", {
      botNames: NAMES, botOpenId: "ou_bot",
      mentions: [{ id: { open_id: "ou_bot" }, key: "@_user_1", name: "小达" }],
    });
  });

  it("migration 013 升级路径：012 时代的旧表执行 013 后新增 TEXT 列且旧行保留", () => {
    const db = openDb();
    // 模拟 012 时代的 inbox_events（无 raw_content）与存量数据
    db.exec("CREATE TABLE inbox_events (event_id TEXT PRIMARY KEY, chat_id TEXT, content_md5 TEXT, ts BIGINT, verdict TEXT)");
    db.prepare("INSERT INTO inbox_events (event_id, chat_id, content_md5, ts) VALUES ('old1','oc_x','m',1)").run();
    const dir = join(dirname(fileURLToPath(import.meta.url)), "../server/db/migrations");
    db.exec(readFileSync(join(dir, "013_inbox_raw.sql"), "utf8"));   // 013 必须自带 ALTER,不许把列挪进 003
    const col = db.prepare("PRAGMA table_info(inbox_events)").all().find((c) => c.name === "raw_content");
    expect(col?.type).toBe("TEXT");
    expect(db.prepare("SELECT chat_id FROM inbox_events WHERE event_id='old1'").get().chat_id).toBe("oc_x");
  });
});

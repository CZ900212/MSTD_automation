// Task 7 C3.3：群聊滚动窗口——observed 一次性消费机制退役,@ 回合注入"截至本批之前"
// 的最近 30 条(user/assistant,含自身发言),重复 @ 不丢上下文。
import { describe, it, expect, vi, beforeEach } from "vitest";
import { openDb, migrate } from "../server/db/index.mjs";
import { createSessionStore } from "../server/sessions/store.mjs";
import { createTurnHandler } from "../server/gateway/turn-handler.mjs";

describe("群@ 回合滚动窗口注入（Task 7）", () => {
  let db, store, session, deps, handler;
  beforeEach(() => {
    db = openDb();
    migrate(db);
    store = createSessionStore(db);
    session = store.getOrCreate("feishu:group:oc_1", { kind: "group", chatId: "oc_1" });
    deps = {
      triage: { triage: vi.fn(async () => ({ action: "escalate", brief: "回答问题" })) },
      brain: { turn: vi.fn(async () => ({ finalText: "", events: [] })), steer: vi.fn(), isBusy: () => false },
      renderReply: vi.fn(async () => ({ text: "x", usage: null })),
      outbound: { sendMessage: vi.fn(async () => ({ messageId: "om" })) },
      store,
      budget: { allow: () => ({ ok: true }), record: vi.fn() },
    };
    handler = createTurnHandler(deps);
  });

  it("observed 累积 → 每次 @ 都注入窗口块,重复 @ 不丢内容(一次性消费已退役)", async () => {
    for (let i = 0; i < 3; i++) {
      store.append(session.id, { role: "user", senderName: `员工${i}`, content: `旁听消息${i}`, observed: true, ts: 1000 + i });
    }
    await handler.handleTurn({
      kind: "message", session, sessionKey: "feishu:group:oc_1",
      items: [{ content: "[@我] 刚才大家聊到哪了？", senderOpenId: "ou_a", senderName: "张三", ts: 2000 }],
      mode: "addressed",
    });
    const ctx = deps.brain.turn.mock.calls[0][0].context;
    expect(ctx).toContain("[群内最近消息-截至本批之前]");
    expect(ctx).toContain("旁听消息0");
    expect(ctx).toContain("旁听消息2");

    await handler.handleTurn({
      kind: "message", session, sessionKey: "feishu:group:oc_1",
      items: [{ content: "[@我] 再问一句", senderOpenId: "ou_a", senderName: "张三", ts: 3000 }],
      mode: "addressed",
    });
    const ctx2 = deps.brain.turn.mock.calls[1][0].context;
    expect(ctx2).toContain("旁听消息0");                       // 滚动窗口:第二问仍可见
    expect(ctx2).toContain("刚才大家聊到哪了");                 // 上一批(含 @ 本身)也进了窗口
    expect(ctx2.match(/再问一句/g)).toHaveLength(1);           // 第二问本体恰一次
    expect(ctx2).not.toContain("自你上次发言以来");             // 旧定界符退役
    // 退役 API 不再导出——回加旧一次性消费实现必须红
    expect(store.recentObserved).toBeUndefined();
    expect(store.markObservedConsumed).toBeUndefined();
  });

  it("窗口滚动截断:60 条旁听只留最近 30 条,最旧的滚出", async () => {
    for (let i = 0; i < 60; i++) {
      store.append(session.id, { role: "user", senderName: "甲", content: `m${i}#`, observed: true, ts: 1000 + i });
    }
    await handler.handleTurn({
      kind: "message", session, sessionKey: "feishu:group:oc_1",
      items: [{ content: "[@我] 总结", senderOpenId: "ou_a", senderName: "张三", ts: 5000 }],
      mode: "addressed",
    });
    const ctx = deps.brain.turn.mock.calls[0][0].context;
    expect(ctx).toContain("m30#");
    expect(ctx).toContain("m59#");
    expect(ctx).not.toContain("m29#");
  });
});

import { describe, it, expect, vi, beforeEach } from "vitest";
import { openDb, migrate } from "../server/db/index.mjs";
import { createSessionStore } from "../server/sessions/store.mjs";
import { createTurnHandler } from "../server/gateway/turn-handler.mjs";

describe("群@ 回合 pending observed 窗口注入", () => {
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

  it("observed 累积 → @ 时注入 pending 块 → 再 @ 不重复注入；50 条截断", async () => {
    // 旁听积累 3 条
    for (let i = 0; i < 3; i++) {
      store.append(session.id, { role: "user", senderName: `员工${i}`, content: `旁听消息${i}`, observed: true, ts: 1000 + i });
    }
    expect(store.recentObserved(session.id)).toHaveLength(3);

    await handler.handleTurn({
      kind: "message", session, sessionKey: "feishu:group:oc_1",
      items: [{ content: "@bot 刚才大家聊到哪了？", senderOpenId: "ou_a", senderName: "张三", ts: 2000 }],
      mode: "addressed",
    });
    const ctx = deps.brain.turn.mock.calls[0][0].context;
    expect(ctx).toContain("仅供上下文");
    expect(ctx).toContain("旁听消息0");
    expect(ctx).toContain("旁听消息2");

    // 已消费：再 @ 不重复注入
    await handler.handleTurn({
      kind: "message", session, sessionKey: "feishu:group:oc_1",
      items: [{ content: "@bot 再问一句", senderOpenId: "ou_a", senderName: "张三", ts: 3000 }],
      mode: "addressed",
    });
    const ctx2 = deps.brain.turn.mock.calls[1][0].context;
    expect(ctx2).not.toContain("旁听消息0");
  });

  it("recentObserved 默认 50 条截断（取最近的）", () => {
    for (let i = 0; i < 60; i++) {
      store.append(session.id, { role: "user", content: `m${i}`, observed: true, ts: 1000 + i });
    }
    const got = store.recentObserved(session.id);
    expect(got).toHaveLength(50);
    expect(got[0].content).toBe("m10");            // 最早的 10 条被截掉
    expect(got.at(-1).content).toBe("m59");
  });
});

import { describe, it, expect, vi, beforeEach } from "vitest";
import { openDb, migrate } from "../server/db/index.mjs";
import { createSessionStore } from "../server/sessions/store.mjs";
import { createCompactor, shouldCompact } from "../server/memory/compact.mjs";

describe("上下文压缩 + flush + nudge", () => {
  it("shouldCompact 阈值判定", () => {
    expect(shouldCompact(1000, 2000)).toBe(false);
    expect(shouldCompact(2001, 2000)).toBe(true);
  });

  describe("compact 流程", () => {
    let db, store, session, calls, compactor;
    beforeEach(() => {
      db = openDb();
      migrate(db);
      store = createSessionStore(db);
      session = store.getOrCreate("feishu:p2p:ou_a", { kind: "p2p" });
      for (let i = 0; i < 30; i++) {
        store.append(session.id, { role: i % 2 ? "assistant" : "user", content: `第${i}条消息内容`, ts: 1000 + i });
      }
      calls = [];
      compactor = createCompactor({
        caller: { call: vi.fn(async (chain) => { calls.push(`summarize:${chain}`); return { text: "【摘要】前十条讲了X", usage: null }; }) },
        store,
        thresholdTokens: 10,          // 强制触发
        keepRecent: 20,
      });
    });

    it("flush 先于摘要；近 20 条原文保留；压缩点落 system 摘要", async () => {
      const brain = { turn: vi.fn(async () => { calls.push("flush"); return { finalText: "", events: [] }; }), isBusy: () => false };
      const r = await compactor.maybeCompact({ session, sessionKey: "feishu:p2p:ou_a", brain });
      expect(r.compacted).toBe(true);
      expect(calls[0]).toBe("flush");                       // flush 先行
      expect(calls[1]).toBe("summarize:reason");            // 摘要走 reason 链
      const t = store.transcript(session.id);
      expect(t.filter((m) => m.role !== "system")).toHaveLength(20);   // 近 20 条保留
      expect(t[0].role).toBe("system");
      expect(t[0].content).toContain("摘要");
      // 幂等：再压不动
      const r2 = await compactor.maybeCompact({ session, sessionKey: "feishu:p2p:ou_a", brain });
      expect(r2.compacted).toBe(false);
    });
  });

  // Task 6：earlyText 统一历史行——tool 行标 [内部记录] 不冒充用户
  it("earlyText 的 tool 行标 [内部记录]", async () => {
    const db = openDb(); migrate(db);
    const store = createSessionStore(db);
    const session = store.getOrCreate("feishu:p2p:ou_t6", { kind: "p2p" });
    store.append(session.id, { role: "tool", content: "内部X", ts: 1 });          // 最早,必落 early 段
    for (let i = 0; i < 25; i++) store.append(session.id, { role: "user", senderName: "张三", content: `第${i}条`, ts: 10 + i });
    const call = vi.fn(async () => ({ text: "摘要", usage: null }));
    const compactor = createCompactor({ caller: { call }, store, thresholdTokens: 10, keepRecent: 20 });
    const r = await compactor.maybeCompact({
      session, sessionKey: "feishu:p2p:ou_t6",
      brain: { turn: vi.fn(async () => ({ finalText: "", events: [] })), isBusy: () => false },
    });
    expect(r.compacted).toBe(true);
    const earlyText = call.mock.calls[0][1].messages[0].content;
    expect(earlyText).toContain("[内部记录]: 内部X");
    expect(earlyText).not.toContain("[用户]: 内部X");
  });

  // Task 7:nudge 判定迁 store.claimMemoryNudge(持久 watermark),状态机测试见 session-store.test.mjs
});

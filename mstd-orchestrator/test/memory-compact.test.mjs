import { describe, it, expect, vi, beforeEach } from "vitest";
import { openDb, migrate } from "../server/db/index.mjs";
import { createSessionStore } from "../server/sessions/store.mjs";
import { createCompactor, shouldCompact, shouldNudge } from "../server/memory/compact.mjs";

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

  it("nudge 每 10 用户轮触发一次，从 transcript 重算（重启安全）", () => {
    const db = openDb();
    migrate(db);
    const store = createSessionStore(db);
    const s = store.getOrCreate("feishu:p2p:ou_b", { kind: "p2p" });
    for (let i = 0; i < 9; i++) store.append(s.id, { role: "user", content: `u${i}`, ts: i });
    expect(shouldNudge(store.transcript(s.id))).toBe(false);
    store.append(s.id, { role: "user", content: "u10", ts: 100 });
    expect(shouldNudge(store.transcript(s.id))).toBe(true);
    store.append(s.id, { role: "user", content: "u11", ts: 101 });
    expect(shouldNudge(store.transcript(s.id))).toBe(false);
  });
});

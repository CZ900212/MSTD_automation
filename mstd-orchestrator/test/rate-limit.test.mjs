import { describe, it, expect, beforeEach } from "vitest";
import { openDb, migrate } from "../server/db/index.mjs";
import { createSessionStore } from "../server/sessions/store.mjs";
import { createProactiveLimiter } from "../server/gateway/rate-limit.mjs";

const H = 3600_000;

describe("群主动发言限额器", () => {
  let db, store, limiter, session;
  beforeEach(() => {
    db = openDb();
    migrate(db);
    store = createSessionStore(db);
    session = store.getOrCreate("feishu:group:oc_1", { kind: "group", chatId: "oc_1" });
    limiter = createProactiveLimiter(db);
  });

  it("每群每小时上限（默认 4）+ 小时窗滑动", () => {
    const t0 = 10 * H;
    // 穿插人类消息避免触发连续上限
    for (let i = 0; i < 4; i++) {
      store.append(session.id, { role: "user", content: `人话${i}`, ts: t0 + i * 600_000 - 1 });
      expect(limiter.allow("oc_1", t0 + i * 600_000)).toBe(true);
      limiter.record("oc_1", t0 + i * 600_000);
    }
    store.append(session.id, { role: "user", content: "又一句", ts: t0 + 40 * 60_000 });
    expect(limiter.allow("oc_1", t0 + 41 * 60_000)).toBe(false);          // 小时内已 4 条
    expect(limiter.allow("oc_1", t0 + 61 * 60_000)).toBe(true);           // 最早一条滑出窗口
    expect(limiter.allow("oc_2", t0)).toBe(true);                          // 别群不受影响
  });

  it("连续主动消息 ≤2：无人类消息间隔时第三条被拒；人类插话后重置", () => {
    const t0 = 100 * H;
    store.append(session.id, { role: "user", content: "有人说话", ts: t0 - 1000 });
    limiter.record("oc_1", t0);
    limiter.record("oc_1", t0 + 1000);
    expect(limiter.allow("oc_1", t0 + 2000)).toBe(false);                  // 连续第 3 条
    store.append(session.id, { role: "user", content: "人类插话", ts: t0 + 3000 });
    expect(limiter.allow("oc_1", t0 + 4000)).toBe(true);                   // 重置
  });

  it("按群策略覆盖小时上限", () => {
    db.prepare("INSERT INTO group_policies (chat_id, policy, hourly_proactive_limit, updated_at) VALUES ('oc_1','ambient',1,0)").run();
    const t0 = 200 * H;
    store.append(session.id, { role: "user", content: "x", ts: t0 - 1 });
    limiter.record("oc_1", t0);
    store.append(session.id, { role: "user", content: "y", ts: t0 + 500 });
    expect(limiter.allow("oc_1", t0 + 1000)).toBe(false);                  // 上限 1
  });

  it("持久化：重建 limiter 计数仍在（重启不清零）", () => {
    const t0 = 300 * H;
    limiter.record("oc_1", t0);
    limiter.record("oc_1", t0 + 1);
    const limiter2 = createProactiveLimiter(db);
    expect(limiter2.allow("oc_1", t0 + 2000)).toBe(false);                 // 连续 2 条仍被记住
  });
});

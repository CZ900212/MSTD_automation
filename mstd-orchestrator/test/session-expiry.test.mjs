import { describe, it, expect, vi, beforeEach } from "vitest";
import { openDb, migrate } from "../server/db/index.mjs";
import { createSessionStore } from "../server/sessions/store.mjs";
import { createSessionExpiry } from "../server/ticker/session-expiry.mjs";

// 北京 2026-07-09：04:00 = UTC 2026-07-08T20:00
const BJ_0400 = Date.UTC(2026, 6, 8, 20, 0, 0);
const NOW = BJ_0400 + 6 * 3600_000;   // 北京 10:00

describe("会话过期重置（flush 先行 + 豁免）", () => {
  let db, store, brain, expiry, activeJobs;
  beforeEach(() => {
    db = openDb();
    migrate(db);
    store = createSessionStore(db);
    brain = { turn: vi.fn(async () => ({ finalText: "", events: [] })), isBusy: () => false };
    activeJobs = new Set();
    expiry = createSessionExpiry({
      db, agentStore: store, brain,
      hasActiveJob: (key) => activeJobs.has(key),
    });
  });

  function mkSession(key, lastTs) {
    const s = store.getOrCreate(key, { kind: "p2p" }, lastTs);
    db.prepare("UPDATE agent_sessions SET updated_at = ? WHERE id = ?").run(lastTs, s.id);
    return s;
  }

  it("24h 空闲过期；每日 04:00 重置；活跃的不动", async () => {
    mkSession("feishu:p2p:ou_idle", NOW - 25 * 3600_000);          // 空闲 25h
    mkSession("feishu:p2p:ou_early", BJ_0400 - 3600_000);          // 今晨 04:00 前活跃（3h 空闲 < 24h 但跨了 04:00）
    mkSession("feishu:p2p:ou_fresh", NOW - 3600_000);              // 04:00 后活跃
    const r = await expiry.sweep(NOW);
    expect(r.archived).toBe(2);
    const statuses = Object.fromEntries(
      db.prepare("SELECT session_key, status FROM agent_sessions").all().map((x) => [x.session_key, x.status])
    );
    expect(statuses["feishu:p2p:ou_idle"]).toBe("archived");
    expect(statuses["feishu:p2p:ou_early"]).toBe("archived");
    expect(statuses["feishu:p2p:ou_fresh"]).toBe("active");
  });

  it("归档前先 memory flush 回合", async () => {
    const s = mkSession("feishu:p2p:ou_idle", NOW - 25 * 3600_000);
    store.append(s.id, { role: "user", content: "有内容的会话", ts: NOW - 25 * 3600_000 });
    db.prepare("UPDATE agent_sessions SET updated_at = ? WHERE id = ?").run(NOW - 25 * 3600_000, s.id);
    const order = [];
    brain.turn.mockImplementation(async () => { order.push("flush"); return { finalText: "", events: [] }; });
    const origArchive = db.prepare("UPDATE agent_sessions SET status='archived' WHERE id = ?");
    await expiry.sweep(NOW);
    expect(order).toEqual(["flush"]);
    expect(brain.turn.mock.calls[0][0].brief).toContain("memory");
    void origArchive;
  });

  it("有活跃后台 job 的会话豁免", async () => {
    mkSession("feishu:p2p:ou_busy", NOW - 25 * 3600_000);
    activeJobs.add("feishu:p2p:ou_busy");
    const r = await expiry.sweep(NOW);
    expect(r.archived).toBe(0);
    expect(db.prepare("SELECT status FROM agent_sessions WHERE session_key='feishu:p2p:ou_busy'").get().status).toBe("active");
  });
});

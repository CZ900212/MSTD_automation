import { describe, it, expect, vi, beforeEach } from "vitest";
import { openDb, migrate } from "../server/db/index.mjs";
import { createSessionStore } from "../server/sessions/store.mjs";
import { createSessionExpiry } from "../server/ticker/session-expiry.mjs";

// 北京 2026-07-09：04:00 = UTC 2026-07-08T20:00
const BJ_0400 = Date.UTC(2026, 6, 8, 20, 0, 0);
const NOW = BJ_0400 + 6 * 3600_000;   // 北京 10:00

describe("会话过期重置（flush 先行 + 豁免）", () => {
  let db, store, actors, brain, expiry, activeJobs;
  beforeEach(() => {
    db = openDb();
    migrate(db);
    store = createSessionStore(db);
    actors = { enqueue: vi.fn((key, callback) => callback()) };
    brain = { turn: vi.fn(async () => ({ finalText: "", events: [] })), isBusy: () => false };
    activeJobs = new Set();
    expiry = createSessionExpiry({
      db, agentStore: store, actors, brain,
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
    expect(actors.enqueue).toHaveBeenCalledTimes(2);
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
    expect(db.prepare("SELECT status FROM agent_sessions WHERE id = ?").get(s.id).status).toBe("archived");
    void origArchive;
  });

  it("候选排队期间被 touch 后，锁内复查阻止 flush 与归档", async () => {
    const s = mkSession("feishu:p2p:ou_race", NOW - 25 * 3600_000);
    store.append(s.id, { role: "user", content: "排队前已有内容", ts: NOW - 25 * 3600_000 });
    db.prepare("UPDATE agent_sessions SET updated_at = ? WHERE id = ?").run(NOW - 25 * 3600_000, s.id);
    let queuedCallback;
    actors.enqueue.mockImplementation((_, callback) => {
      queuedCallback = callback;
    });

    const result = await expiry.sweep(NOW);
    expect(result.archived).toBe(0);
    expect(actors.enqueue).toHaveBeenCalledWith("feishu:p2p:ou_race", expect.any(Function));
    store.touch(s.id, NOW);
    await queuedCallback();

    expect(brain.turn).not.toHaveBeenCalled();
    expect(db.prepare("SELECT status FROM agent_sessions WHERE id = ?").get(s.id).status).toBe("active");
  });

  it("候选排队期间出现活跃后台 job 后，锁内复查阻止 flush 与归档", async () => {
    const s = mkSession("feishu:p2p:ou_job_race", NOW - 25 * 3600_000);
    store.append(s.id, { role: "user", content: "排队前已有内容", ts: NOW - 25 * 3600_000 });
    db.prepare("UPDATE agent_sessions SET updated_at = ? WHERE id = ?").run(NOW - 25 * 3600_000, s.id);
    let queuedCallback;
    actors.enqueue.mockImplementation((_, callback) => {
      queuedCallback = callback;
    });

    const result = await expiry.sweep(NOW);
    activeJobs.add("feishu:p2p:ou_job_race");
    await queuedCallback();

    expect(result.archived).toBe(0);
    expect(brain.turn).not.toHaveBeenCalled();
    expect(db.prepare("SELECT status FROM agent_sessions WHERE id = ?").get(s.id).status).toBe("active");
  });

  it("flush 期间被 touch 后，最终条件归档不计数且保持 active", async () => {
    const s = mkSession("feishu:p2p:ou_flush_race", NOW - 25 * 3600_000);
    store.append(s.id, { role: "user", content: "需要 flush 的内容", ts: NOW - 25 * 3600_000 });
    db.prepare("UPDATE agent_sessions SET updated_at = ? WHERE id = ?").run(NOW - 25 * 3600_000, s.id);
    let releaseFlush;
    brain.turn.mockImplementation(() => new Promise((resolve) => {
      releaseFlush = resolve;
    }));

    const pending = expiry.sweep(NOW);
    await vi.waitFor(() => expect(brain.turn).toHaveBeenCalledTimes(1));
    store.touch(s.id, NOW);
    releaseFlush({ finalText: "", events: [] });
    const result = await pending;

    expect(result.archived).toBe(0);
    expect(db.prepare("SELECT status FROM agent_sessions WHERE id = ?").get(s.id).status).toBe("active");
  });

  it("flush 期间出现活跃后台 job 后，二次复查阻止归档", async () => {
    const sessionKey = "feishu:p2p:ou_flush_job";
    const s = mkSession(sessionKey, NOW - 25 * 3600_000);
    store.append(s.id, { role: "user", content: "会触发 memory flush", ts: NOW - 25 * 3600_000 });
    db.prepare("UPDATE agent_sessions SET updated_at = ? WHERE id = ?").run(NOW - 25 * 3600_000, s.id);
    brain.turn.mockImplementation(async () => {
      activeJobs.add(sessionKey);
      return { finalText: "", events: [] };
    });

    const result = await expiry.sweep(NOW);

    expect(activeJobs.has(sessionKey)).toBe(true);
    expect(result.archived).toBe(0);
    expect(db.prepare("SELECT status FROM agent_sessions WHERE id = ?").get(s.id).status).toBe("active");
  });

  it("第二次同步 job 检查返回后不让出微任务，立即执行归档 UPDATE", async () => {
    const s = mkSession("feishu:p2p:ou_sync_check", NOW - 25 * 3600_000);
    store.append(s.id, { role: "user", content: "需要 flush 的内容", ts: NOW - 25 * 3600_000 });
    db.prepare("UPDATE agent_sessions SET updated_at = ? WHERE id = ?").run(NOW - 25 * 3600_000, s.id);
    const order = [];
    const expiryDb = {
      prepare(sql) {
        const statement = db.prepare(sql);
        if (!sql.startsWith("UPDATE agent_sessions SET status = 'archived'")) return statement;
        return {
          run(...args) {
            order.push("archive-update");
            return statement.run(...args);
          },
        };
      },
    };
    let checks = 0;
    const syncExpiry = createSessionExpiry({
      db: expiryDb,
      agentStore: store,
      actors,
      brain,
      hasActiveJob: () => {
        checks += 1;
        order.push(`check${checks}`);
        if (checks === 2) queueMicrotask(() => order.push("job-microtask"));
        return false;
      },
    });

    const result = await syncExpiry.sweep(NOW);

    expect(result.archived).toBe(1);
    expect(order).toEqual(["check1", "check2", "archive-update", "job-microtask"]);
  });

  it.each([
    ["Promise", Promise.resolve(false)],
    ["非 boolean", 0],
  ])("hasActiveJob 返回%s时明确拒绝且不 flush/归档", async (_label, invalidValue) => {
    const s = mkSession(`feishu:p2p:ou_invalid_${_label}`, NOW - 25 * 3600_000);
    store.append(s.id, { role: "user", content: "不能进入 flush", ts: NOW - 25 * 3600_000 });
    db.prepare("UPDATE agent_sessions SET updated_at = ? WHERE id = ?").run(NOW - 25 * 3600_000, s.id);
    const archiveRun = vi.fn();
    const expiryDb = {
      prepare(sql) {
        const statement = db.prepare(sql);
        if (!sql.startsWith("UPDATE agent_sessions SET status = 'archived'")) return statement;
        return {
          run(...args) {
            archiveRun(...args);
            return statement.run(...args);
          },
        };
      },
    };
    const strictExpiry = createSessionExpiry({
      db: expiryDb,
      agentStore: store,
      actors,
      brain,
      hasActiveJob: () => invalidValue,
    });

    await expect(strictExpiry.sweep(NOW)).rejects.toThrowError(
      "createSessionExpiry: hasActiveJob 必须同步返回 boolean"
    );
    expect(brain.turn).not.toHaveBeenCalled();
    expect(archiveRun).not.toHaveBeenCalled();
    expect(db.prepare("SELECT status FROM agent_sessions WHERE id = ?").get(s.id).status).toBe("active");
  });

  it("有活跃后台 job 的会话豁免", async () => {
    mkSession("feishu:p2p:ou_busy", NOW - 25 * 3600_000);
    activeJobs.add("feishu:p2p:ou_busy");
    const r = await expiry.sweep(NOW);
    expect(r.archived).toBe(0);
    expect(db.prepare("SELECT status FROM agent_sessions WHERE session_key='feishu:p2p:ou_busy'").get().status).toBe("active");
  });
});

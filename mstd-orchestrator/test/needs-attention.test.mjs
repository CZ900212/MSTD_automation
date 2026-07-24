import { describe, it, expect } from "vitest";
import { openDb, migrate } from "../server/db/index.mjs";
import { countNeedsAttention, reportNeedsAttentionOnBoot } from "../server/health/needs-attention.mjs";

function freshDb() {
  const db = openDb(":memory:");
  migrate(db);
  return db;
}

function seedJob(db, id, status) {
  db.prepare(
    "INSERT INTO orch_jobs (id, template_id, status, created_at, updated_at) VALUES (?,?,?,?,?)",
  ).run(id, "meeting_to_task", status, 1, 1);
}

describe("countNeedsAttention", () => {
  it("只数 needs_attention 状态", () => {
    const db = freshDb();
    seedJob(db, "j1", "needs_attention");
    seedJob(db, "j2", "needs_attention");
    seedJob(db, "j3", "done");
    expect(countNeedsAttention(db)).toBe(2);
  });
});

describe("reportNeedsAttentionOnBoot", () => {
  it("0 积压：不打日志不告警", async () => {
    const db = freshDb();
    const logs = [];
    let alerted = false;
    const out = await reportNeedsAttentionOnBoot({ db, alert: async () => { alerted = true; }, log: (m) => logs.push(m) });
    expect(out).toEqual({ count: 0, alerted: false });
    expect(alerted).toBe(false);
    expect(logs).toHaveLength(0);
  });

  it(">0 积压：打日志且发一条告警", async () => {
    const db = freshDb();
    seedJob(db, "j1", "needs_attention");
    const logs = [];
    const alerts = [];
    const out = await reportNeedsAttentionOnBoot({ db, alert: async (t) => alerts.push(t), log: (m) => logs.push(m) });
    expect(out).toEqual({ count: 1, alerted: true });
    expect(logs.some((l) => /需人工处理/.test(l))).toBe(true);
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toMatch(/needs_attention/);
  });

  it(">0 积压但无 alert：打日志、alerted=false", async () => {
    const db = freshDb();
    seedJob(db, "j1", "needs_attention");
    const out = await reportNeedsAttentionOnBoot({ db, alert: null, log: () => {} });
    expect(out).toEqual({ count: 1, alerted: false });
  });

  it("告警发送抛错不炸：降级为日志、alerted=false", async () => {
    const db = freshDb();
    seedJob(db, "j1", "needs_attention");
    const logs = [];
    const out = await reportNeedsAttentionOnBoot({
      db,
      alert: async () => { throw new Error("网络断了"); },
      log: (m) => logs.push(m),
    });
    expect(out.alerted).toBe(false);
    expect(logs.some((l) => /告警发送失败/.test(l))).toBe(true);
  });

  it("DB 异常（表缺失）降级为日志，不抛", async () => {
    const badDb = { prepare: () => { throw new Error("no such table"); } };
    const logs = [];
    const out = await reportNeedsAttentionOnBoot({ db: badDb, alert: null, log: (m) => logs.push(m) });
    expect(out).toEqual({ count: 0, alerted: false });
    expect(logs.some((l) => /计数失败/.test(l))).toBe(true);
  });
});

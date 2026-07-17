import { describe, it, expect, vi, beforeEach } from "vitest";
import { openDb, migrate } from "../server/db/index.mjs";
import { createSemaphore } from "../server/jobs/semaphore.mjs";
import { createBackgroundJobs } from "../server/jobs/background.mjs";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

describe("后台 job 委托（orch_jobs 复用 + 版本快照 + 信号量）", () => {
  let db;
  beforeEach(() => { db = openDb(); migrate(db); });

  it("spawn 立即返回 jobId（会话不阻塞）；job 落库带 sessionVersion；完成回调携带结果", async () => {
    let release;
    const runJob = vi.fn(() => new Promise((r) => { release = () => r("深度检索结果"); }));
    const done = [];
    const bg = createBackgroundJobs({ db, semaphore: createSemaphore(2), runJob, onComplete: (x) => done.push(x) });
    const jobId = bg.spawn({
      sessionKey: "feishu:p2p:ou_a",
      sessionVersion: 3,
      taskId: "task-a",
      originRunId: "run-a",
      dispatchId: "dispatch-a",
      kind: "research",
      params: { q: "供应商报价" },
    });
    expect(typeof jobId).toBe("string");
    const row = db.prepare("SELECT * FROM orch_jobs WHERE id = ?").get(jobId);
    expect(row.template_id).toBe("agent_background");
    expect(JSON.parse(row.params_json)).toMatchObject({
      sessionKey: "feishu:p2p:ou_a",
      sessionVersion: 3,
      taskId: "task-a",
      originRunId: "run-a",
      dispatchId: "dispatch-a",
      kind: "research",
    });
    expect(row.status).toBe("running");
    release();
    await sleep(10);
    expect(db.prepare("SELECT status FROM orch_jobs WHERE id = ?").get(jobId).status).toBe("done");
    expect(done).toHaveLength(1);
    expect(done[0]).toMatchObject({
      jobId,
      sessionKey: "feishu:p2p:ou_a",
      sessionVersion: 3,
      taskId: "task-a",
      originRunId: "run-a",
      dispatchId: "dispatch-a",
      ok: true,
      derived_result: { text: "深度检索结果", sensitivity: "internal" },
    });
  });

  it("未知 sensitivity 标签 fail-closed 降级 restricted;缺省标签走 internal 默认", async () => {
    const done = [];
    const bg = createBackgroundJobs({
      db,
      semaphore: createSemaphore(2),
      runJob: vi.fn(async ({ kind }) => (kind === "unknown-label"
        ? { text: "密", sensitivity: "secret" }   // 非枚举标签
        : { text: "普通" })),                     // 缺省标签
      onComplete: (x) => done.push(x),
    });
    bg.spawn({ sessionKey: "feishu:p2p:ou_a", sessionVersion: 0, kind: "unknown-label", params: {} });
    bg.spawn({ sessionKey: "feishu:p2p:ou_a", sessionVersion: 0, kind: "no-label", params: {} });
    await sleep(20);
    const byKind = Object.fromEntries(done.map((d) => [d.kind, d.derived_result.sensitivity]));
    expect(byKind["unknown-label"]).toBe("restricted"); // fail-closed:回注端会拒发
    expect(byKind["no-label"]).toBe("internal");        // legacy 纯文本边界的既定默认
  });

  it("completion carries a structured derived_result with parent provenance and sensitivity", async () => {
    const done = [];
    const bg = createBackgroundJobs({
      db,
      semaphore: createSemaphore(1),
      runJob: vi.fn(async () => ({ text: "供应商报价汇总", sensitivity: "internal" })),
      onComplete: (x) => done.push(x),
    });
    bg.spawn({ sessionKey: "feishu:p2p:ou_a", sessionVersion: 3, kind: "research", brief: "查报价", params: { q: "供应商" } });
    await sleep(10);
    expect(done[0]).toMatchObject({ ok: true, derived_result: { text: "供应商报价汇总", sensitivity: "internal" } });
    expect(done[0].derived_result.parent).toEqual({ kind: "research", brief: "查报价" });
    expect(done[0]).not.toHaveProperty("result");
  });

  it("信号量限流：超出并发的 job 排队，前一个完成后自动泵出", async () => {
    const running = [];
    const releases = [];
    const runJob = vi.fn(({ jobId }) => new Promise((r) => { running.push(jobId); releases.push(() => r("ok")); }));
    const bg = createBackgroundJobs({ db, semaphore: createSemaphore(1), runJob, onComplete: () => {} });
    const j1 = bg.spawn({ sessionKey: "s1", sessionVersion: 0, kind: "a", params: {} });
    const j2 = bg.spawn({ sessionKey: "s2", sessionVersion: 0, kind: "b", params: {} });
    await sleep(10);
    expect(running).toEqual([j1]);
    expect(db.prepare("SELECT status FROM orch_jobs WHERE id = ?").get(j2).status).toBe("queued");
    releases[0]();
    await sleep(10);
    expect(running).toEqual([j1, j2]);
  });

  it("共享信号量：他方（launcher 侧）release 也会泵出本队列——修交叉饥饿", async () => {
    const sem = createSemaphore(1);
    expect(sem.tryAcquire()).toBe(true);   // 模拟 launcher job 占满唯一槽位
    const running = [];
    const bg = createBackgroundJobs({
      db, semaphore: sem,
      runJob: vi.fn(async ({ jobId }) => { running.push(jobId); return "ok"; }),
      onComplete: () => {},
    });
    const j = bg.spawn({ sessionKey: "s", sessionVersion: 0, kind: "x", params: {} });
    await sleep(10);
    expect(running).toEqual([]);           // 槽满排队
    sem.release();                          // launcher 侧完成——修复前 bg 队列永久滞留 queued
    await sleep(10);
    expect(running).toEqual([j]);
    expect(db.prepare("SELECT status FROM orch_jobs WHERE id = ?").get(j).status).toBe("done");
  });

  it("recoverOnBoot：崩溃遗留的裸 running 收口为 failed 并回调 onComplete(ok:false) 闭环", async () => {
    // 手工制造崩溃残留：上一进程 spawn 后死在执行窗口内
    db.prepare(
      "INSERT INTO orch_jobs (id, template_id, title, status, params_json, created_at, updated_at) VALUES ('stale-run','agent_background','深度检索','running',?,1,1)"
    ).run(JSON.stringify({ sessionKey: "feishu:p2p:ou_a", sessionVersion: 2, taskId: "task-z", kind: "research" }));
    const done = [];
    const events = [];
    const bg = createBackgroundJobs({
      db, semaphore: createSemaphore(1), runJob: vi.fn(),
      onComplete: (x) => done.push(x), onEvent: (x) => events.push(x),
    });
    const out = bg.recoverOnBoot();
    expect(out).toEqual({ recovered: 1 });
    expect(db.prepare("SELECT status FROM orch_jobs WHERE id='stale-run'").get().status).toBe("failed");
    expect(done[0]).toMatchObject({ jobId: "stale-run", sessionKey: "feishu:p2p:ou_a", taskId: "task-z", ok: false, errorKind: "crashed" });
    expect(events[0]).toMatchObject({ type: "background_job_failed", jobId: "stale-run", errorKind: "crashed" });
    const evt = db.prepare("SELECT * FROM job_events WHERE job_id='stale-run' AND type='background_failed'").get();
    expect(JSON.parse(evt.payload_json).errorKind).toBe("crashed");
  });

  it("runJob 抛错 → 状态 failed，回调 ok:false", async () => {
    const done = [];
    const events = [];
    const bg = createBackgroundJobs({
      db, semaphore: createSemaphore(1),
      runJob: vi.fn(async () => { throw new Error("炸了"); }),
      onComplete: (x) => done.push(x),
      onEvent: (x) => events.push(x),
    });
    const jobId = bg.spawn({ sessionKey: "s", sessionVersion: 0, kind: "x", params: {} });
    await sleep(10);
    expect(db.prepare("SELECT status FROM orch_jobs WHERE id = ?").get(jobId).status).toBe("failed");
    expect(done[0]).toMatchObject({ ok: false, errorKind: "unknown" });
    expect(done[0]).not.toHaveProperty("error");
    expect(events).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "background_job_failed", errorKind: "unknown", error: "炸了" }),
    ]));
    const failure = db.prepare("SELECT * FROM job_events WHERE job_id = ? AND type = 'background_failed'").get(jobId);
    expect(JSON.parse(failure.payload_json)).toEqual({ errorKind: "unknown", error: "炸了" });
  });
});

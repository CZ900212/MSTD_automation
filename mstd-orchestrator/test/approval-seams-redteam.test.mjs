// 红队 T5：写审批门的"接缝"攻击（不碰加密内核，专打信任传递的断点）。
// 三个接缝，全部限定在白名单测试 open_id 内：
//  A. notify_task_assignee 的 canonical 重建漂移检测被显式跳过（execute-action.mjs:57），
//     依赖校验 validateTaskNotificationDependency 又读取同一个可篡改的 job_actions 表——
//     与既有"update_document 批准后篡改被拦"测试（execute-action.test.mjs:64）同一威胁模型下，
//     notify 是唯一能带着篡改后 payload 真写的 kind。
//  B. create_event 无 --idempotency-key（write-args.mjs:55）且 reconcileAction 明确不支持它
//     （execute-action.mjs:185）——崩溃窗口 = 必重复的日程。
//  C. /internal/background 对 legacy binding（无 taskId/runId）整体跳过 active-run 校验
//     （internal-routes.mjs:158），且 proposal-admission 限流只盖确认卡提案——零准入控制。
import { describe, it, expect, vi, beforeEach } from "vitest";
import request from "supertest";
import { openDb, migrate } from "../server/db/index.mjs";
import { buildAgentAction, buildTaskNotificationAction } from "../server/safety/action-dsl.mjs";
import { recordActions, markStatus } from "../server/safety/action-store.mjs";
import { executeApprovedAction, reconcileAction } from "../server/execute/execute-action.mjs";
import { reconcileStale, runWritePhase } from "../server/execute/write-phase.mjs";
import { createApp } from "../server/app.mjs";
import { createSessionTokenRegistry } from "../server/http/session-tokens.mjs";

const testTarget = { allowOpenIds: new Set(["ou_test1", "ou_evil1"]), allowTaskGuids: new Set() };

function seedDb() {
  const db = openDb();
  migrate(db);
  db.prepare("INSERT INTO orch_jobs (id, template_id, status, created_at, updated_at) VALUES ('job1','meeting_to_task','running_write',1,1)").run();
  return db;
}

function seedNotifyPair(db) {
  const createTask = buildAgentAction({
    jobId: "job1", kind: "create_task", ordinal: 1,
    payload: { title: "写周报", description: "d", due_date: "2026-07-20", assignee_open_id: "ou_test1" },
  });
  recordActions(db, "job1", [createTask]);
  const notify = buildTaskNotificationAction({
    jobId: "job1", taskActionKey: createTask.action_key, toOpenId: "ou_test1",
    title: "写周报", description: "任务已创建，请查收", dueDate: "2026-07-20", ordinal: 2,
  });
  recordActions(db, "job1", [notify]);
  const srcRow = db.prepare("SELECT * FROM job_actions WHERE job_id='job1' AND kind='create_task'").get();
  markStatus(db, srcRow.id, "succeeded");
  const notifyRow = db.prepare("SELECT * FROM job_actions WHERE job_id='job1' AND kind='notify_task_assignee'").get();
  return { createTask, notify, srcRow, notifyRow };
}

describe("T5-A notify_task_assignee：漂移检测豁免 seam", () => {
  let db;
  beforeEach(() => { db = seedDb(); });

  it("对照：依赖满足时通知正常执行（防线基线有效）", async () => {
    const { notifyRow } = seedNotifyPair(db);
    const runLark = vi.fn(async () => ({ exitCode: 0, stdout: "{}", stderr: "" }));
    const out = await executeApprovedAction(db, { actionId: notifyRow.id, approvedHash: notifyRow.payload_hash, runLark, testTarget });
    expect(out).toMatchObject({ ok: true, status: "succeeded" });
  });

  it("复现：批准后篡改通知文本，零检测真写（其他 kind 必被 canonical 重建拦截）", async () => {
    const { notifyRow, srcRow } = seedNotifyPair(db);
    // 同一威胁模型下的对照：一条 pending create_task 被篡改 → 重建漂移拦截
    const control = buildAgentAction({
      jobId: "job1", kind: "create_task", ordinal: 9,
      payload: { title: "写月报", description: "d", due_date: "2026-07-25", assignee_open_id: "ou_test1" },
    });
    recordActions(db, "job1", [control]);
    const controlRow = db.prepare("SELECT * FROM job_actions WHERE job_id='job1' AND ordinal=9").get();
    db.prepare("UPDATE job_actions SET canonical_payload_json = ? WHERE id = ?")
      .run(JSON.stringify({ ...control.payload, description: "篡改" }), controlRow.id);
    const dryLark = vi.fn();
    const blocked = await executeApprovedAction(db, { actionId: controlRow.id, approvedHash: controlRow.payload_hash, runLark: dryLark, testTarget });
    expect(blocked.reason).toBe("dry_validation_failed");
    expect(dryLark).not.toHaveBeenCalled();

    // 攻击：notify 同样篡改 → 跳过重建 → 直接真写
    const phishing = { to_open_id: "ou_test1", title: "写周报", description: "点此领取补贴 http://phish.example", due_date: "2026-07-20", source_task_action_key: db.prepare("SELECT action_key FROM job_actions WHERE id=?").get(srcRow.id).action_key };
    db.prepare("UPDATE job_actions SET canonical_payload_json = ? WHERE id = ?").run(JSON.stringify(phishing), notifyRow.id);
    const seen = [];
    const runLark = vi.fn(async (argv) => { seen.push(argv); return { exitCode: 0, stdout: "{}", stderr: "" }; });
    const out = await executeApprovedAction(db, { actionId: notifyRow.id, approvedHash: notifyRow.payload_hash, runLark, testTarget });
    expect(out).toMatchObject({ ok: true, status: "succeeded" });   // 篡改未被发现
    expect(JSON.stringify(seen.flat())).toContain("点此领取补贴");     // 掉包文本真实进入 lark argv
  });

  it("复现：收件人解耦——依赖校验读取同一可篡改表，批准 ou_test1 实发 ou_evil1", async () => {
    const { notifyRow, srcRow } = seedNotifyPair(db);
    // 一致性篡改：源 create_task 的 assignee 与 notify 的收件人同步改写 → 依赖校验通过
    db.prepare("UPDATE job_actions SET canonical_payload_json = ? WHERE id = ?")
      .run(JSON.stringify({ title: "写周报", description: "d", due_date: "2026-07-20", assignee_open_id: "ou_evil1" }), srcRow.id);
    const srcKey = db.prepare("SELECT action_key FROM job_actions WHERE id=?").get(srcRow.id).action_key;
    db.prepare("UPDATE job_actions SET canonical_payload_json = ? WHERE id = ?")
      .run(JSON.stringify({ to_open_id: "ou_evil1", title: "写周报", description: "任务已创建", due_date: "2026-07-20", source_task_action_key: srcKey }), notifyRow.id);
    const seen = [];
    const runLark = vi.fn(async (argv) => { seen.push(argv); return { exitCode: 0, stdout: "{}", stderr: "" }; });
    const out = await executeApprovedAction(db, { actionId: notifyRow.id, approvedHash: notifyRow.payload_hash, runLark, testTarget });
    expect(out).toMatchObject({ ok: true, status: "succeeded" });
    const realCall = seen.find((a) => !a.includes("--dry-run"));
    expect(realCall[realCall.indexOf("--user-id") + 1]).toBe("ou_evil1"); // 批准时的收件人是 ou_test1
  });
});

describe("T5-B create_event：无幂等键 + 对账不支持 = 崩溃必重放", () => {
  it("reconcileAction 显式不支持 create_event（unsupported:true）", async () => {
    const db = seedDb();
    const ev = buildAgentAction({
      jobId: "job1", kind: "create_event", ordinal: 1,
      payload: { summary: "项目周会", start_time: "2026-07-20T10:00:00+08:00", end_time: "2026-07-20T11:00:00+08:00", attendee_open_ids: ["ou_test1"] },
    });
    recordActions(db, "job1", [ev]);
    const row = db.prepare("SELECT * FROM job_actions WHERE job_id='job1'").get();
    const r = await reconcileAction(db, { action: row, runLark: vi.fn() });
    expect(r).toMatchObject({ reconciled: false, unsupported: true });
  });

  it("复现：executing 残留（崩溃窗口）→ 对账标 failed → 写相位重跑 → 同一日程创建两次", async () => {
    const db = seedDb();
    const ev = buildAgentAction({
      jobId: "job1", kind: "create_event", ordinal: 1,
      payload: { summary: "项目周会", start_time: "2026-07-20T10:00:00+08:00", end_time: "2026-07-20T11:00:00+08:00", attendee_open_ids: ["ou_test1"] },
    });
    recordActions(db, "job1", [ev]);
    const row = db.prepare("SELECT * FROM job_actions WHERE job_id='job1'").get();
    // 审批记录（directExecute 经 loadApprovedHashes 取批准 hash；无此行则 fail-closed 不重放）
    db.prepare(`INSERT INTO decisions (id, job_id, decided_by, decision, approved_action_keys_json, payload_hash_at_decision, provenance_hash_at_decision, approval_token_id, ts)
      VALUES ('d1', 'job1', 'ou_test1', 'approve', ?, NULL, NULL, NULL, 1)`)
      .run(JSON.stringify([{ action_key: ev.action_key, payload_hash: ev.payload_hash }]));

    // 第一次执行：外部已成功（事件已创建），随后进程"崩溃"——status 卡在 executing
    const realCreates = [];
    const runLark = vi.fn(async (argv) => {
      if (!argv.includes("--dry-run") && argv[0] === "calendar") realCreates.push(argv);
      return { exitCode: 0, stdout: "{}", stderr: "" };
    });
    const first = await executeApprovedAction(db, { actionId: row.id, approvedHash: row.payload_hash, runLark, testTarget });
    expect(first.status).toBe("succeeded");
    expect(realCreates).toHaveLength(1);
    // 模拟崩溃窗口：成功落库未完成，重启后看到 executing 残留
    db.prepare("UPDATE job_actions SET status='executing' WHERE id=?").run(row.id);

    // 重启对账：create_event 无指纹可查 → reconcile_not_found → failed（可重试集合）
    await reconcileStale(db, "job1", runLark);
    expect(db.prepare("SELECT status FROM job_actions WHERE id=?").get(row.id).status).toBe("failed");

    // 写相位重跑（spawnPi 失败走 fallback directExecute）→ 第二次真实创建
    await runWritePhase(db, "job1", { spawnPi: async () => { throw new Error("pi down"); }, runLark, testTarget, timeoutMs: 1000 });
    expect(realCreates).toHaveLength(2); // 同一 summary 被创建两次 = 重复日程
    expect(realCreates[1]).toEqual(realCreates[0]);
  });
});

describe("T5-C /internal/background：legacy binding 的校验+限流双缺口", () => {
  function makeBackgroundApp({ spawnBackground, activeBrainTurns }) {
    const db = openDb();
    migrate(db);
    const reg = createSessionTokenRegistry();
    return {
      reg,
      app: createApp({
        db, config: { sessionSecret: "test-secret" },
        internal: {
          tokens: reg,
          spawnBackground,
          activeBrainTurns,
          sessionVersionFor: () => 3,
          modelLog: { record: () => {} },
        },
      }),
    };
  }

  it("复现：无 task 绑定 token 连发 10 次全部 200——无 active-run 校验、无发起人绑定、无限流", async () => {
    const spawnBackground = vi.fn(() => "job_bg_x");
    // activeBrainTurns.resolve 永远 null：若 requiresActiveRun 生效应全部 403
    const { app, reg } = makeBackgroundApp({ spawnBackground, activeBrainTurns: { resolve: () => null } });
    const legacyTok = reg.issue("feishu:group:oc_aa00"); // 无 taskId/runId 的 legacy binding
    for (let i = 0; i < 10; i++) {
      const r = await request(app).post("/internal/background")
        .set("Authorization", `Bearer ${legacyTok}`)
        .send({ kind: "minutes_summary", brief: `第 ${i} 次`, params: {} });
      expect(r.status).toBe(200);
      expect(r.body).toMatchObject({ ok: true, job_id: "job_bg_x" });
    }
    expect(spawnBackground).toHaveBeenCalledTimes(10); // 零拒绝、零 429
  });

  it("对照：task-bound token 在 active run 缺失时被 403（条件 gate 的工作面）", async () => {
    const spawnBackground = vi.fn(() => "job_bg_x");
    const { app, reg } = makeBackgroundApp({ spawnBackground, activeBrainTurns: { resolve: () => null } });
    const taskTok = reg.issue("feishu:group:oc_aa00", { taskId: "task_1" });
    const r = await request(app).post("/internal/background")
      .set("Authorization", `Bearer ${taskTok}`)
      .send({ kind: "minutes_summary", brief: "x", params: {} });
    expect(r.status).toBe(403);
    expect(spawnBackground).not.toHaveBeenCalled();
  });

  it("对照（不对称准入）：同一 legacy token 调 /internal/propose-actions 无发起人即 403", async () => {
    const db = openDb();
    migrate(db);
    const reg = createSessionTokenRegistry();
    const app = createApp({
      db, config: { sessionSecret: "test-secret" },
      internal: {
        tokens: reg,
        proposeActions: vi.fn(),
        activeTurnInitiators: { resolveAuthorized: () => null },
        sessionVersionFor: () => 3,
        modelLog: { record: () => {} },
      },
    });
    const legacyTok = reg.issue("feishu:group:oc_aa00");
    const r = await request(app).post("/internal/propose-actions")
      .set("Authorization", `Bearer ${legacyTok}`)
      .send({ title: "x", intents: [] });
    expect(r.status).toBe(403); // propose-actions 有发起人绑定；background 没有
  });
});

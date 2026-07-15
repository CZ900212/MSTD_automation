import { describe, it, expect, beforeEach, vi } from "vitest";
import { readFileSync } from "node:fs";
import { openDb, migrate } from "../server/db/index.mjs";
import { canonicalizeActions, buildAgentAction } from "../server/safety/action-dsl.mjs";
import { recordActions, actionsToExecute } from "../server/safety/action-store.mjs";
import { executeApprovedAction, reconcileAction, isTaskCompleteResponse } from "../server/execute/execute-action.mjs";
import todoFixture from "./fixtures/task-detail-todo.json" with { type: "json" };
import doneFixture from "./fixtures/task-detail-done.json" with { type: "json" };
import { createHeartbeatStore } from "../server/ticker/heartbeat-store.mjs";

let db;
const testTarget = { allowOpenIds: new Set(["ou_test1"]), allowTaskGuids: new Set(["guid-test"]) };

beforeEach(() => {
  db = openDb(); migrate(db);
  db.prepare("INSERT INTO orch_jobs (id, template_id, status, created_at, updated_at) VALUES ('job1','meeting_to_task','running_write',1,1)").run();
  const actions = canonicalizeActions({ jobId: "job1", items: [
    { owner_name: "张三", task: "写周报", due: "2026-07-15", suggested_open_id: "ou_test1", confidence: "high" },
  ] });
  recordActions(db, "job1", actions);
});

function row() { return actionsToExecute(db, "job1")[0]; }

describe("executeApprovedAction", () => {
  it("结构锁：任务通知依赖校验由命名 helper 持有", () => {
    const src = readFileSync(new URL("../server/execute/execute-action.mjs", import.meta.url), "utf8");
    expect(src).toMatch(/function validateTaskNotificationDependency\(/);
  });

  it("dry-runs then executes, records succeeded + idempotency key present", async () => {
    const seen = [];
    const runLark = vi.fn(async (argv) => { seen.push(argv); return { exitCode: 0, stdout: JSON.stringify({ task_id: "t1" }), stderr: "" }; });
    const r = row();
    const out = await executeApprovedAction(db, { actionId: r.id, approvedHash: r.payload_hash, runLark, testTarget });
    expect(out.ok).toBe(true);
    expect(out.status).toBe("succeeded");
    expect(seen[0]).toContain("--dry-run");
    expect(seen[1]).toContain("--idempotency-key");
    expect(seen[1]).toContain(r.idempotency_key);
    expect(seen[1]).not.toContain("--dry-run");
  });

  it("update_document 先 dry-run 后按精确文档白名单真写", async () => {
    const action = buildAgentAction({
      jobId: "job1", kind: "update_document", ordinal: 8,
      payload: { doc_token: "docxAllowed_123", command: "append", content: "## 会议结论", revision_id: 4, doc_format: "markdown" },
    });
    recordActions(db, "job1", [action]);
    const stored = db.prepare("SELECT * FROM job_actions WHERE job_id='job1' AND kind='update_document'").get();
    const runLark = vi.fn(async () => ({ exitCode: 0, stdout: JSON.stringify({ ok: true }), stderr: "" }));
    const out = await executeApprovedAction(db, {
      actionId: stored.id, approvedHash: stored.payload_hash, runLark,
      testTarget: { allowDocTokens: new Set(["docxAllowed_123"]) },
    });
    expect(out).toMatchObject({ ok: true, status: "succeeded" });
    expect(runLark.mock.calls[0][0]).toContain("--dry-run");
    expect(runLark.mock.calls[1][0]).toEqual([
      "docs", "+update", "--as", "user", "--doc", "docxAllowed_123", "--command", "append",
      "--doc-format", "markdown", "--revision-id", "4", "--content", "## 会议结论", "--json",
    ]);
  });

  it("update_document 批准后 payload JSON 被篡改时不调用 lark", async () => {
    const action = buildAgentAction({
      jobId: "job1", kind: "update_document", ordinal: 8,
      payload: { doc_token: "docxAllowed_123", command: "append", content: "原文", revision_id: 4 },
    });
    recordActions(db, "job1", [action]);
    const stored = db.prepare("SELECT * FROM job_actions WHERE job_id='job1' AND kind='update_document'").get();
    db.prepare("UPDATE job_actions SET canonical_payload_json = ? WHERE id = ?")
      .run(JSON.stringify({ ...action.payload, content: "篡改内容" }), stored.id);
    const runLark = vi.fn();
    const out = await executeApprovedAction(db, {
      actionId: stored.id, approvedHash: stored.payload_hash, runLark,
      testTarget: { allowDocTokens: new Set(["docxAllowed_123"]) },
    });
    expect(out.reason).toBe("dry_validation_failed");
    expect(runLark).not.toHaveBeenCalled();
  });

  it("complete_task 先 dry-run 后真写，且 argv 无伪造幂等参数", async () => {
    const action = buildAgentAction({ jobId: "job1", kind: "complete_task", payload: { task_guid: "guid-test" }, ordinal: 9 });
    recordActions(db, "job1", [action]);
    const stored = db.prepare("SELECT * FROM job_actions WHERE job_id='job1' AND kind='complete_task'").get();
    const runLark = vi.fn(async () => ({ exitCode: 0, stdout: "{}", stderr: "" }));
    const out = await executeApprovedAction(db, { actionId: stored.id, approvedHash: stored.payload_hash, runLark, testTarget });
    expect(out).toMatchObject({ ok: true, status: "succeeded" });
    expect(runLark.mock.calls[0][0]).toEqual(["task", "+complete", "--as", "user", "--task-id", "guid-test", "--dry-run"]);
    expect(runLark.mock.calls[1][0]).toEqual(["task", "+complete", "--as", "user", "--task-id", "guid-test"]);
    expect(runLark.mock.calls.flat(2)).not.toContain("--idempotency-key");
  });

  it("rejects on hash drift without ever calling lark", async () => {
    const runLark = vi.fn();
    const r = row();
    const out = await executeApprovedAction(db, { actionId: r.id, approvedHash: "STALE_HASH", runLark, testTarget });
    expect(out.ok).toBe(false);
    expect(out.reason).toBe("hash_mismatch");
    expect(runLark).not.toHaveBeenCalled();
    expect(db.prepare("SELECT status FROM job_actions WHERE id=?").get(r.id).status).toBe("failed");
  });

  it("fails closed on a non-test target (never executes)", async () => {
    const bad = canonicalizeActions({ jobId: "job1", items: [
      { owner_name: "x", task: "y", due: null, suggested_open_id: "ou_prod", confidence: "high" },
    ] });
    recordActions(db, "job1", bad);
    const target = db.prepare("SELECT * FROM job_actions WHERE job_id='job1'").all()
      .find((x) => JSON.parse(x.canonical_payload_json).assignee_open_id === "ou_prod");
    const runLark = vi.fn();
    const out = await executeApprovedAction(db, { actionId: target.id, approvedHash: target.payload_hash, runLark, testTarget });
    expect(out.ok).toBe(false);
    expect(runLark).not.toHaveBeenCalled();
  });

  it("marks failed when the real exec exits non-zero (dry-run passed)", async () => {
    const runLark = vi.fn()
      .mockResolvedValueOnce({ exitCode: 0, stdout: "(dry ok)", stderr: "" })
      .mockResolvedValueOnce({ exitCode: 1, stdout: "", stderr: "boom" });
    const r = row();
    const out = await executeApprovedAction(db, { actionId: r.id, approvedHash: r.payload_hash, runLark, testTarget });
    expect(out.ok).toBe(false);
    expect(out.status).toBe("failed");
  });

  it("is idempotent: a succeeded action short-circuits (no lark call)", async () => {
    const runLark = vi.fn(async () => ({ exitCode: 0, stdout: "{}", stderr: "" }));
    const r = row();
    await executeApprovedAction(db, { actionId: r.id, approvedHash: r.payload_hash, runLark, testTarget });
    runLark.mockClear();
    const again = await executeApprovedAction(db, { actionId: r.id, approvedHash: r.payload_hash, runLark, testTarget });
    expect(again.status).toBe("succeeded");
    expect(runLark).not.toHaveBeenCalled();
  });

  // Task 4B：批准 hash 缺失不再默认放行——fail-closed
  it("fails closed when approvedHash is missing (null 不再等于免检)", async () => {
    const runLark = vi.fn();
    const r = row();
    const out = await executeApprovedAction(db, { actionId: r.id, approvedHash: null, runLark, testTarget });
    expect(out.ok).toBe(false);
    expect(out.reason).toBe("not_approved");
    expect(runLark).not.toHaveBeenCalled();
    expect(db.prepare("SELECT status FROM job_actions WHERE id=?").get(r.id).status).toBe("failed");
  });
});

// ---- Task 4B: schedule_reminder 专用 adapter（不构造 lark argv）----
describe("executeApprovedAction schedule_reminder（Task 4B）", () => {
  const tt = { allowOpenIds: new Set(["ou_tgt"]), allowChatIds: new Set(["oc_tgt"]) };
  const DUE_EPOCH = Date.parse("2026-07-12T01:00:00.000Z");
  let heartbeat, action;
  beforeEach(() => {
    db.prepare(
      "INSERT INTO orch_jobs (id, template_id, status, created_at, updated_at, params_json) VALUES ('job2','agent_write','awaiting_confirm',1,1,?)"
    ).run(JSON.stringify({ sessionKey: "feishu:p2p:ou_owner", initiatorOpenId: "ou_owner" }));
    const a = buildAgentAction({
      jobId: "job2", kind: "schedule_reminder", ordinal: 0,
      payload: { deliver_to: "feishu:p2p:ou_tgt", due_iso: "2026-07-12T09:00:00+08:00", text: "交周报" },
    });
    recordActions(db, "job2", [a]);
    action = db.prepare("SELECT * FROM job_actions WHERE job_id='job2'").get();
    heartbeat = createHeartbeatStore(db);
  });

  it("批准后恰插一条 owner-bound 记录；owner 来自 job params 而非 payload；不调 runLark", async () => {
    const runLark = vi.fn();
    const out = await executeApprovedAction(db, { actionId: action.id, approvedHash: action.payload_hash, runLark, testTarget: tt, heartbeat });
    expect(out.ok).toBe(true);
    expect(out.status).toBe("succeeded");
    expect(runLark).not.toHaveBeenCalled();
    const rows = db.prepare("SELECT * FROM heartbeat_items").all();
    expect(rows).toHaveLength(1);
    expect(rows[0].owner_session_key).toBe("feishu:p2p:ou_owner");
    expect(rows[0].deliver_to).toBe("feishu:p2p:ou_tgt");
    expect(rows[0].due_at).toBe(DUE_EPOCH);
    expect(rows[0].text).toBe("交周报");                    // 落库文本 = 批准文本，不许改写
    expect(rows[0].source_action_id).toBe(action.id);
    expect(rows[0].status).toBe("pending");
  });

  // §5.2 审卷补杀：owner=群会话（≠发起人 open_id）也必须原样落库——owner 不得从 initiator 推导
  it("group 会话 owner：owner_session_key = 群会话键，与发起人 open_id 无关", async () => {
    db.prepare("UPDATE orch_jobs SET params_json = ? WHERE id = 'job2'")
      .run(JSON.stringify({ sessionKey: "feishu:group:oc_own", initiatorOpenId: "ou_clicker" }));
    const out = await executeApprovedAction(db, { actionId: action.id, approvedHash: action.payload_hash, runLark: vi.fn(), testTarget: tt, heartbeat });
    expect(out.ok).toBe(true);
    const row = db.prepare("SELECT * FROM heartbeat_items").get();
    expect(row.owner_session_key).toBe("feishu:group:oc_own");
    expect(row.deliver_to).toBe("feishu:p2p:ou_tgt");
  });

  // §5.2 审卷补杀：幂等键 = source_action_id 本身——不同 action、相同 payload 必须各插一行
  it("两个不同 action 相同 payload：各自成行，不得按内容去重", async () => {
    const b = buildAgentAction({
      jobId: "job2", kind: "schedule_reminder", ordinal: 1,
      payload: { deliver_to: "feishu:p2p:ou_tgt", due_iso: "2026-07-12T09:00:00+08:00", text: "交周报" },
    });
    recordActions(db, "job2", [b]);
    const actionB = db.prepare("SELECT * FROM job_actions WHERE job_id='job2' AND ordinal=1").get();
    await executeApprovedAction(db, { actionId: action.id, approvedHash: action.payload_hash, runLark: vi.fn(), testTarget: tt, heartbeat });
    await executeApprovedAction(db, { actionId: actionB.id, approvedHash: actionB.payload_hash, runLark: vi.fn(), testTarget: tt, heartbeat });
    const rows = db.prepare("SELECT source_action_id FROM heartbeat_items ORDER BY created_at, id").all();
    expect(rows).toHaveLength(2);
    expect(new Set(rows.map((r) => r.source_action_id))).toEqual(new Set([action.id, actionB.id]));
  });

  it("重试幂等：source_action_id 去重，仍恰一条且返回 succeeded", async () => {
    await executeApprovedAction(db, { actionId: action.id, approvedHash: action.payload_hash, runLark: vi.fn(), testTarget: tt, heartbeat });
    db.prepare("UPDATE job_actions SET status='failed' WHERE id=?").run(action.id);   // 模拟中断后的重试
    const again = await executeApprovedAction(db, { actionId: action.id, approvedHash: action.payload_hash, runLark: vi.fn(), testTarget: tt, heartbeat });
    expect(again.ok).toBe(true);
    expect(again.status).toBe("succeeded");
    expect(db.prepare("SELECT COUNT(*) n FROM heartbeat_items").get().n).toBe(1);
  });

  it("hash drift → 零插入", async () => {
    const out = await executeApprovedAction(db, { actionId: action.id, approvedHash: "STALE", runLark: vi.fn(), testTarget: tt, heartbeat });
    expect(out.ok).toBe(false);
    expect(out.reason).toBe("hash_mismatch");
    expect(db.prepare("SELECT COUNT(*) n FROM heartbeat_items").get().n).toBe(0);
  });

  it("批准 hash 缺失（null）→ 零插入", async () => {
    const out = await executeApprovedAction(db, { actionId: action.id, approvedHash: null, runLark: vi.fn(), testTarget: tt, heartbeat });
    expect(out.ok).toBe(false);
    expect(out.reason).toBe("not_approved");
    expect(db.prepare("SELECT COUNT(*) n FROM heartbeat_items").get().n).toBe(0);
  });

  it("非测试目标 → 零插入", async () => {
    const out = await executeApprovedAction(db, {
      actionId: action.id, approvedHash: action.payload_hash, runLark: vi.fn(),
      testTarget: { allowOpenIds: new Set(["ou_other"]), allowChatIds: new Set() }, heartbeat,
    });
    expect(out.ok).toBe(false);
    expect(out.reason).toBe("non_test_target");
    expect(db.prepare("SELECT COUNT(*) n FROM heartbeat_items").get().n).toBe(0);
  });

  it("缺 heartbeat adapter → fail-closed 零插入（绝不回落 lark argv）", async () => {
    const runLark = vi.fn();
    const out = await executeApprovedAction(db, { actionId: action.id, approvedHash: action.payload_hash, runLark, testTarget: tt });
    expect(out.ok).toBe(false);
    expect(runLark).not.toHaveBeenCalled();
    expect(db.prepare("SELECT COUNT(*) n FROM heartbeat_items").get().n).toBe(0);
  });

  // §5.1 审核补杀：owner 与 addOwned 同标准——cron/debug 发起的 job 即使过确认卡也拒绝
  it.each([["cron 会话", "cron:job-9"], ["debug 会话", "debug:d1"], ["raw open_id", "ou_owner"], ["缺 owner", null]])(
    "owner 非 canonical（%s）→ fail-closed 零插入", async (_label, sessionKey) => {
      db.prepare("UPDATE orch_jobs SET params_json = ? WHERE id = 'job2'")
        .run(JSON.stringify(sessionKey === null ? {} : { sessionKey }));
      const out = await executeApprovedAction(db, { actionId: action.id, approvedHash: action.payload_hash, runLark: vi.fn(), testTarget: tt, heartbeat });
      expect(out.ok).toBe(false);
      expect(out.reason).toBe("no_owner_session");
      expect(db.prepare("SELECT COUNT(*) n FROM heartbeat_items").get().n).toBe(0);
    }
  );

  // §5.1 审核补杀：本地 DB 写的对账指纹 = heartbeat_items.source_action_id，绝不打 lark
  it("reconcileAction：只认本 action 的指纹——他人 row 在场仍 miss；本 action row 在 → succeeded；全程不调 lark", async () => {
    const runLark = vi.fn();
    // 先给另一个 action 插入一条同内容提醒：当前 action 的对账不得被它蒙混（防 LIMIT 1 式松弛）
    const b = buildAgentAction({
      jobId: "job2", kind: "schedule_reminder", ordinal: 1,
      payload: { deliver_to: "feishu:p2p:ou_tgt", due_iso: "2026-07-12T09:00:00+08:00", text: "交周报" },
    });
    recordActions(db, "job2", [b]);
    const actionB = db.prepare("SELECT * FROM job_actions WHERE job_id='job2' AND ordinal=1").get();
    await executeApprovedAction(db, { actionId: actionB.id, approvedHash: actionB.payload_hash, runLark: vi.fn(), testTarget: tt, heartbeat });

    db.prepare("UPDATE job_actions SET status='executing' WHERE id=?").run(action.id);
    const miss = await reconcileAction(db, { action: { ...action, status: "executing" }, runLark });
    expect(miss.reconciled).toBe(false);                     // 他人 row 在场，本 action 仍 miss
    await executeApprovedAction(db, { actionId: action.id, approvedHash: action.payload_hash, runLark: vi.fn(), testTarget: tt, heartbeat });
    db.prepare("UPDATE job_actions SET status='executing' WHERE id=?").run(action.id);   // 模拟崩溃残留
    const hit = await reconcileAction(db, { action: { ...action, status: "executing" }, runLark });
    expect(hit.reconciled).toBe(true);
    expect(db.prepare("SELECT status FROM job_actions WHERE id=?").get(action.id).status).toBe("succeeded");
    expect(runLark).not.toHaveBeenCalled();
  });
});

describe("notify_task_assignee dependency", () => {
  function seedNotificationJob() {
    db.prepare("INSERT INTO orch_jobs (id, template_id, status, created_at, updated_at) VALUES ('notify-job','meeting_to_task','executing',1,1)").run();
    const actions = canonicalizeActions({
      jobId: "notify-job",
      notificationMode: "card",
      items: [{ owner_name: "张三", task: "完成询价", due: "2026-07-15", suggested_open_id: "ou_test1", confidence: "high" }],
    });
    recordActions(db, "notify-job", actions);
    const rows = db.prepare("SELECT * FROM job_actions WHERE job_id='notify-job' ORDER BY ordinal").all();
    return { task: rows[0], notice: rows[1] };
  }

  it("does not call lark until the linked task succeeds", async () => {
    const { notice } = seedNotificationJob();
    const runLark = vi.fn();
    const out = await executeApprovedAction(db, {
      actionId: notice.id, approvedHash: notice.payload_hash, runLark, testTarget,
    });
    expect(out).toMatchObject({ ok: false, reason: "dependency_not_succeeded" });
    expect(runLark).not.toHaveBeenCalled();
  });

  it("sends after task success and preserves the notification idempotency key", async () => {
    const { task, notice } = seedNotificationJob();
    db.prepare("UPDATE job_actions SET status='succeeded' WHERE id=?").run(task.id);
    const runLark = vi.fn(async () => ({ exitCode: 0, stdout: "{}", stderr: "" }));
    const out = await executeApprovedAction(db, {
      actionId: notice.id, approvedHash: notice.payload_hash, runLark, testTarget,
    });
    expect(out).toMatchObject({ ok: true, status: "succeeded" });
    expect(runLark).toHaveBeenCalledTimes(2);
    expect(runLark.mock.calls[1][0]).toContain(notice.idempotency_key);
  });

  it("fails closed when the notification recipient differs from the final task assignee", async () => {
    const { task, notice } = seedNotificationJob();
    const taskPayload = JSON.parse(task.canonical_payload_json);
    taskPayload.assignee_open_id = "ou_other";
    db.prepare("UPDATE job_actions SET status='succeeded', canonical_payload_json=? WHERE id=?")
      .run(JSON.stringify(taskPayload), task.id);
    const runLark = vi.fn();
    const out = await executeApprovedAction(db, {
      actionId: notice.id, approvedHash: notice.payload_hash, runLark, testTarget,
    });
    expect(out).toMatchObject({ ok: false, reason: "dependency_not_succeeded" });
    expect(runLark).not.toHaveBeenCalled();
  });

  it("a notification retry never re-runs its already-succeeded task", async () => {
    const { task, notice } = seedNotificationJob();
    db.prepare("UPDATE job_actions SET status='succeeded' WHERE id=?").run(task.id);
    const firstRun = vi.fn()
      .mockResolvedValueOnce({ exitCode: 0, stdout: "dry", stderr: "" })
      .mockResolvedValueOnce({ exitCode: 1, stdout: "", stderr: "send failed" });
    await executeApprovedAction(db, {
      actionId: notice.id, approvedHash: notice.payload_hash, runLark: firstRun, testTarget,
    });
    const retryable = actionsToExecute(db, "notify-job");
    expect(retryable.map((a) => a.id)).toEqual([notice.id]);

    const retryRun = vi.fn(async () => ({ exitCode: 0, stdout: "{}", stderr: "" }));
    await executeApprovedAction(db, {
      actionId: notice.id, approvedHash: notice.payload_hash, runLark: retryRun, testTarget,
    });
    expect(db.prepare("SELECT status FROM job_actions WHERE id=?").get(task.id).status).toBe("succeeded");
    expect(retryRun).toHaveBeenCalledTimes(2);
  });
});

describe("reconcileAction", () => {
  it("marks succeeded if the task fingerprint is found externally", async () => {
    const r = row();
    db.prepare("UPDATE job_actions SET status='executing' WHERE id=?").run(r.id);
    const runLark = vi.fn(async () => ({ exitCode: 0, stdout: JSON.stringify({ items: [{ idempotency_key: r.idempotency_key, task_id: "t9" }] }), stderr: "" }));
    const out = await reconcileAction(db, { action: { ...r, status: "executing" }, runLark });
    expect(out.reconciled).toBe(true);
  });

  it("complete_task 只按同一 GUID 的已验证完成态对账", async () => {
    expect(isTaskCompleteResponse(JSON.stringify(todoFixture), "task-guid-fixture")).toBe(false);
    expect(isTaskCompleteResponse(JSON.stringify(doneFixture), "task-guid-fixture")).toBe(true);
    expect(isTaskCompleteResponse(JSON.stringify(doneFixture), "other-guid")).toBe(false);

    const action = {
      id: "a-complete", kind: "complete_task", status: "executing",
      canonical_payload_json: JSON.stringify({ task_guid: "task-guid-fixture" }),
    };
    db.prepare(
      `INSERT INTO orch_jobs (id, template_id, status, params_json, created_at, updated_at)
       VALUES ('j-complete', 'agent_write', 'executing', '{}', 1, 1)`
    ).run();
    db.prepare(
      `INSERT INTO job_actions (id, job_id, action_key, kind, canonical_payload_json, payload_hash, idempotency_key, status, ordinal, ts)
       VALUES (?, 'j-complete', 'k-complete', 'complete_task', ?, 'h', 'i', 'executing', 0, 1)`
    ).run(action.id, action.canonical_payload_json);
    const runLark = vi.fn(async () => ({ exitCode: 0, stdout: JSON.stringify(doneFixture), stderr: "" }));
    expect(await reconcileAction(db, { action, runLark })).toEqual({ reconciled: true });
    expect(runLark).toHaveBeenCalledWith(["task", "tasks", "get", "--task-guid", "task-guid-fixture", "--as", "user"]);
  });

  it.each(["notify_task_assignee", "send_dm", "send_group_msg", "create_event"])(
    "%s never queries the task list",
    async (kind) => {
      const runLark = vi.fn();
      const out = await reconcileAction(db, {
        action: { id: `a-${kind}`, kind, idempotency_key: `k-${kind}` }, runLark,
      });
      expect(out).toEqual({ reconciled: false, unsupported: true });
      expect(runLark).not.toHaveBeenCalled();
    }
  );
});

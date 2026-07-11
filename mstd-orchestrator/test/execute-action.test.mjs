import { describe, it, expect, beforeEach, vi } from "vitest";
import { openDb, migrate } from "../server/db/index.mjs";
import { canonicalizeActions, buildAgentAction } from "../server/safety/action-dsl.mjs";
import { recordActions, actionsToExecute } from "../server/safety/action-store.mjs";
import { executeApprovedAction, reconcileAction } from "../server/execute/execute-action.mjs";
import { createHeartbeatStore } from "../server/ticker/heartbeat-store.mjs";

let db;
const testTarget = { allowOpenIds: new Set(["ou_test1"]), allowTasklist: "tl_test" };

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

describe("reconcileAction", () => {
  it("marks succeeded if the fingerprint is found externally", async () => {
    const r = row();
    db.prepare("UPDATE job_actions SET status='executing' WHERE id=?").run(r.id);
    const runLark = vi.fn(async () => ({ exitCode: 0, stdout: JSON.stringify({ items: [{ idempotency_key: r.idempotency_key, task_id: "t9" }] }), stderr: "" }));
    const out = await reconcileAction(db, { action: { ...r, status: "executing" }, runLark });
    expect(out.reconciled).toBe(true);
  });
});

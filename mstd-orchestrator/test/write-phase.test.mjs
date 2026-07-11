import { describe, it, expect, beforeEach, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { openDb, migrate } from "../server/db/index.mjs";
import { canonicalizeActions, buildAgentAction } from "../server/safety/action-dsl.mjs";
import { recordActions, actionsToExecute } from "../server/safety/action-store.mjs";
import { runWritePhase } from "../server/execute/write-phase.mjs";
import { createHeartbeatStore } from "../server/ticker/heartbeat-store.mjs";

let db;
const testTarget = { allowOpenIds: new Set(["ou_test1"]), allowTasklist: "tl_test" };

beforeEach(() => {
  db = openDb(); migrate(db);
  db.prepare("INSERT INTO orch_jobs (id, template_id, status, created_at, updated_at) VALUES ('job1','meeting_to_task','running_write',1,1)").run();
  const actions = canonicalizeActions({ jobId: "job1", items: [
    { owner_name: "张三", task: "写周报", due: null, suggested_open_id: "ou_test1", confidence: "high" },
  ] });
  recordActions(db, "job1", actions);
  const a = actionsToExecute(db, "job1")[0];
  db.prepare(
    "INSERT INTO decisions (id, job_id, decided_by, decision, approved_action_keys_json, ts) VALUES ('d1','job1','ou_test1','approve',?,1)"
  ).run(JSON.stringify([{ action_key: a.action_key, payload_hash: a.payload_hash }]));
});

describe("runWritePhase", () => {
  it("falls back to direct sequential execution when Pi cannot start", async () => {
    const spawnPi = vi.fn(async () => { throw new Error("pi spawn failed"); });
    const calls = [];
    const runLark = vi.fn(async (argv) => { calls.push(argv); return { exitCode: 0, stdout: "{}", stderr: "" }; });
    const out = await runWritePhase(db, "job1", { spawnPi, runLark, testTarget });
    expect(out.mode).toBe("fallback");
    expect(out.results[0].ok).toBe(true);
    expect(calls[0]).toContain("--dry-run");
    expect(calls[1]).toContain("--idempotency-key");
    expect(actionsToExecute(db, "job1")).toHaveLength(0);
  });

  it("uses Pi mode when spawnPi resolves cleanly", async () => {
    const spawnPi = vi.fn(async () => ({ ok: true }));
    const runLark = vi.fn(async () => ({ exitCode: 0, stdout: "{}", stderr: "" }));
    const out = await runWritePhase(db, "job1", { spawnPi, runLark, testTarget });
    expect(out.mode).toBe("pi");
  });

  it("写前对账：executing 残留先 reconcile，命中外部指纹则不重复执行", async () => {
    const action = actionsToExecute(db, "job1")[0];
    db.prepare("UPDATE job_actions SET status = 'executing' WHERE id = ?").run(action.id);
    const calls = [];
    const runLark = async (argv) => {
      calls.push(argv.join(" "));
      if (argv[0] === "task" && argv[1] === "+list") {
        return {
          exitCode: 0,
          stdout: JSON.stringify({ items: [{ idempotency_key: action.idempotency_key }] }),
          stderr: "",
        };
      }
      return { exitCode: 0, stdout: "{}", stderr: "" };
    };
    await runWritePhase(db, "job1", {
      spawnPi: async () => { throw new Error("force fallback"); },
      runLark,
      testTarget,
    });
    const row = db.prepare("SELECT status, result_json FROM job_actions WHERE id = ?").get(action.id);
    expect(row.status).toBe("succeeded");
    expect(row.result_json).toContain("reconciled");
    // 已对账成功的动作不应再被真写（argv 中不出现它的 idempotency-key）
    expect(calls.filter((c) => c.includes(action.idempotency_key)).length).toBe(0);
  });
});

// ---- Task 4B: schedule_reminder 走 generic write phase fallback ----
describe("runWritePhase schedule_reminder（Task 4B）", () => {
  const tt = { allowOpenIds: new Set(["ou_tgt"]), allowChatIds: new Set() };
  const failPi = async () => { throw new Error("force fallback"); };
  let action;

  const approve = (entries, ts = 5) => {
    db.prepare(
      "INSERT INTO decisions (id, job_id, decided_by, decision, approved_action_keys_json, ts) VALUES (?, 'job2', 'ou_owner', 'approve', ?, ?)"
    ).run(randomUUID(), JSON.stringify(entries), ts);
  };

  beforeEach(() => {
    db.prepare(
      "INSERT INTO orch_jobs (id, template_id, status, created_at, updated_at, params_json) VALUES ('job2','agent_write','running_write',1,1,?)"
    ).run(JSON.stringify({ sessionKey: "feishu:p2p:ou_owner" }));
    const a = buildAgentAction({
      jobId: "job2", kind: "schedule_reminder", ordinal: 0,
      payload: { deliver_to: "feishu:p2p:ou_tgt", due_iso: "2026-07-12T09:00:00+08:00", text: "交周报" },
    });
    recordActions(db, "job2", [a]);
    action = actionsToExecute(db, "job2")[0];
  });

  it("fallback 直执行经同一 heartbeat adapter：恰插一条 owner 正确，不构造 lark argv", async () => {
    approve([{ action_key: action.action_key, payload_hash: action.payload_hash }]);
    const runLark = vi.fn(async () => ({ exitCode: 0, stdout: "{}", stderr: "" }));
    const out = await runWritePhase(db, "job2", { spawnPi: failPi, runLark, testTarget: tt, heartbeat: createHeartbeatStore(db) });
    expect(out.mode).toBe("fallback");
    expect(out.results[0].ok).toBe(true);
    const rows = db.prepare("SELECT * FROM heartbeat_items").all();
    expect(rows).toHaveLength(1);
    expect(rows[0].owner_session_key).toBe("feishu:p2p:ou_owner");
    expect(rows[0].deliver_to).toBe("feishu:p2p:ou_tgt");
    expect(rows[0].text).toBe("交周报");                    // 落库文本 = 批准文本
    expect(runLark).not.toHaveBeenCalled();                 // 本地 DB 写，零 lark 调用
  });

  it("缺 heartbeat adapter → fail-closed 零插入", async () => {
    approve([{ action_key: action.action_key, payload_hash: action.payload_hash }]);
    const out = await runWritePhase(db, "job2", { spawnPi: failPi, runLark: vi.fn(async () => ({ exitCode: 0, stdout: "{}", stderr: "" })), testTarget: tt });
    expect(out.results[0].ok).toBe(false);
    expect(db.prepare("SELECT COUNT(*) n FROM heartbeat_items").get().n).toBe(0);
  });

  it("无 decision → fail-closed 零插入（不许拿当前 row hash 冒充批准值）", async () => {
    const out = await runWritePhase(db, "job2", { spawnPi: failPi, runLark: vi.fn(), testTarget: tt, heartbeat: createHeartbeatStore(db) });
    expect(out.results[0].ok).toBe(false);
    expect(out.results[0].reason).toBe("not_approved");
    expect(db.prepare("SELECT COUNT(*) n FROM heartbeat_items").get().n).toBe(0);
  });

  it("同一毫秒两条 approve：按 rowid 取最新（先 stale 后 correct → 成功）", async () => {
    approve([{ action_key: action.action_key, payload_hash: "STALE_OLD" }], 5);
    approve([{ action_key: action.action_key, payload_hash: action.payload_hash }], 5);
    const out = await runWritePhase(db, "job2", { spawnPi: failPi, runLark: vi.fn(), testTarget: tt, heartbeat: createHeartbeatStore(db) });
    expect(out.results[0].ok).toBe(true);
    expect(db.prepare("SELECT COUNT(*) n FROM heartbeat_items").get().n).toBe(1);
  });

  it("同一毫秒两条 approve 反向（先 correct 后 stale）→ 以最新为准 hash_mismatch", async () => {
    approve([{ action_key: action.action_key, payload_hash: action.payload_hash }], 5);
    approve([{ action_key: action.action_key, payload_hash: "STALE_NEW" }], 5);
    const out = await runWritePhase(db, "job2", { spawnPi: failPi, runLark: vi.fn(), testTarget: tt, heartbeat: createHeartbeatStore(db) });
    expect(out.results[0].ok).toBe(false);
    expect(out.results[0].reason).toBe("hash_mismatch");
    expect(db.prepare("SELECT COUNT(*) n FROM heartbeat_items").get().n).toBe(0);
  });

  // §5.2 审卷补杀：ts 才是第一排序键——旧 ts 后插入（rowid 更大）也不能赢过新 ts
  it("ts 不同：取 ts 最新的 decision，旧 ts 后插入（大 rowid）不得胜出", async () => {
    approve([{ action_key: action.action_key, payload_hash: action.payload_hash }], 10);   // 新 ts 先插
    approve([{ action_key: action.action_key, payload_hash: "STALE_OLD_TS" }], 5);         // 旧 ts 后插，rowid 更大
    const out = await runWritePhase(db, "job2", { spawnPi: failPi, runLark: vi.fn(), testTarget: tt, heartbeat: createHeartbeatStore(db) });
    expect(out.results[0].ok).toBe(true);
    expect(db.prepare("SELECT COUNT(*) n FROM heartbeat_items").get().n).toBe(1);
  });

  // §5.2 审卷补杀：decision 存在但缺当前 action_key → 不得回退当前 row hash
  it("decision 只批准了别的 action：当前 action not_approved 零插入", async () => {
    approve([{ action_key: "some_other_action", payload_hash: "whatever" }]);
    const out = await runWritePhase(db, "job2", { spawnPi: failPi, runLark: vi.fn(), testTarget: tt, heartbeat: createHeartbeatStore(db) });
    expect(out.results[0].ok).toBe(false);
    expect(out.results[0].reason).toBe("not_approved");
    expect(db.prepare("SELECT COUNT(*) n FROM heartbeat_items").get().n).toBe(0);
  });
});

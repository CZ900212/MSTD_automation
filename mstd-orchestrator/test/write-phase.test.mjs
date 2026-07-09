import { describe, it, expect, beforeEach, vi } from "vitest";
import { openDb, migrate } from "../server/db/index.mjs";
import { canonicalizeActions } from "../server/safety/action-dsl.mjs";
import { recordActions, actionsToExecute } from "../server/safety/action-store.mjs";
import { runWritePhase } from "../server/execute/write-phase.mjs";

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

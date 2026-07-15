import { describe, it, expect, beforeEach } from "vitest";
import { openDb, migrate } from "../server/db/index.mjs";
import { canonicalizeActions } from "../server/safety/action-dsl.mjs";
import { recordActions, actionsToExecute } from "../server/safety/action-store.mjs";
import { reconcileOnBoot } from "../server/execute/reconcile-startup.mjs";

let db;

beforeEach(() => {
  db = openDb();
  migrate(db);
});

function seedJob(id, status, items = null) {
  db.prepare(
    "INSERT INTO orch_jobs (id, template_id, status, created_at, updated_at) VALUES (?,?,?,1,1)"
  ).run(id, "meeting_to_task", status);
  if (items) {
    const actions = canonicalizeActions({ jobId: id, items });
    recordActions(db, id, actions);
    return actionsToExecute(db, id);
  }
  return [];
}

describe("reconcileOnBoot", () => {
  it("executing 动作 + task +list 命中指纹 → succeeded，job running_write → done", async () => {
    const rows = seedJob("job1", "running_write", [
      { owner_name: "张三", task: "写周报", due: null, suggested_open_id: "ou_test1", confidence: "high" },
    ]);
    const action = rows[0];
    db.prepare("UPDATE job_actions SET status = 'executing' WHERE id = ?").run(action.id);

    const runLark = async (argv) => {
      if (argv[0] === "task" && argv[1] === "+list") {
        return {
          exitCode: 0,
          stdout: JSON.stringify({ items: [{ idempotency_key: action.idempotency_key, task_id: "t9" }] }),
          stderr: "",
        };
      }
      return { exitCode: 0, stdout: "{}", stderr: "" };
    };

    const out = await reconcileOnBoot(db, { runLark, now: () => 99 });
    expect(out.reconciled).toBe(1);
    expect(out.failed).toBe(0);
    expect(out.jobsFinalized).toBe(1);

    const a = db.prepare("SELECT status, result_json FROM job_actions WHERE id = ?").get(action.id);
    expect(a.status).toBe("succeeded");
    expect(a.result_json).toContain("reconciled");

    const job = db.prepare("SELECT status, updated_at FROM orch_jobs WHERE id = 'job1'").get();
    expect(job.status).toBe("done");
    expect(job.updated_at).toBe(99);
  });

  it("未命中指纹 → 动作 failed，job running_write → partial_failed", async () => {
    const rows = seedJob("job2", "running_write", [
      { owner_name: "李四", task: "发纪要", due: null, suggested_open_id: "ou_test2", confidence: "high" },
    ]);
    const action = rows[0];
    db.prepare("UPDATE job_actions SET status = 'executing' WHERE id = ?").run(action.id);

    const runLark = async () => ({
      exitCode: 0,
      stdout: JSON.stringify({ items: [] }),
      stderr: "",
    });

    const out = await reconcileOnBoot(db, { runLark, now: () => 100 });
    expect(out.reconciled).toBe(0);
    expect(out.failed).toBe(1);
    expect(out.jobsFinalized).toBe(1);

    const a = db.prepare("SELECT status, result_json FROM job_actions WHERE id = ?").get(action.id);
    expect(a.status).toBe("failed");
    expect(a.result_json).toContain("reconcile_not_found_on_boot");

    const job = db.prepare("SELECT status FROM orch_jobs WHERE id = 'job2'").get();
    expect(job.status).toBe("partial_failed");
  });

  it("确认流 executing job：动作全部成功后启动收口为 done", async () => {
    const rows = seedJob("job-confirm-done", "executing", [
      { owner_name: "王五", task: "确认报价", due: null, suggested_open_id: "ou_test3", confidence: "high" },
    ]);
    db.prepare("UPDATE job_actions SET status='succeeded' WHERE id=?").run(rows[0].id);
    const out = await reconcileOnBoot(db, {
      runLark: async () => ({ exitCode: 0, stdout: "{}", stderr: "" }), now: () => 102,
    });
    expect(out.jobsFinalized).toBe(1);
    expect(db.prepare("SELECT status FROM orch_jobs WHERE id='job-confirm-done'").get().status).toBe("done");
  });

  it("写闸关闭时保守保留 executing job，等待下次可对账启动", async () => {
    seedJob("job-confirm-deferred", "executing", [
      { owner_name: "赵六", task: "核对合同", due: null, suggested_open_id: "ou_test4", confidence: "high" },
    ]);
    const out = await reconcileOnBoot(db, { runLark: null, now: () => 103 });
    expect(out.jobsFinalized).toBe(0);
    expect(db.prepare("SELECT status FROM orch_jobs WHERE id='job-confirm-deferred'").get().status).toBe("executing");
  });

  it("running_readonly 残留 job → failed", async () => {
    seedJob("job3", "running_readonly");

    const out = await reconcileOnBoot(db, { runLark: null, now: () => 101 });
    expect(out.reconciled).toBe(0);
    expect(out.failed).toBe(0);
    expect(out.jobsFinalized).toBe(1);

    const job = db.prepare("SELECT status FROM orch_jobs WHERE id = 'job3'").get();
    expect(job.status).toBe("failed");
  });
});

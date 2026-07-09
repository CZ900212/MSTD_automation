import { describe, it, expect } from "vitest";
import { openDb, migrate } from "../server/db/index.mjs";
import { canonicalizeActions } from "../server/safety/action-dsl.mjs";
import { recordActions } from "../server/safety/action-store.mjs";
import { runWriteFlow } from "../server/jobs/write-flow.mjs";
import { createEventBus } from "../server/jobs/event-bus.mjs";
import { createEventBuffer } from "../server/jobs/event-buffer.mjs";

function seedApprovedJob() {
  const db = openDb();
  migrate(db);
  const jobId = "job-write-1";
  db.prepare(
    "INSERT INTO orch_jobs (id, template_id, status, created_at, updated_at) VALUES (?,?,?,?,?)"
  ).run(jobId, "meeting_to_task", "approved", 1, 1);
  const items = [
    { owner_name: "张三", task: "写周报", due: "2026-07-15", suggested_open_id: "ou_test1", confidence: "high" },
    { owner_name: "李四", task: "发纪要", due: "2026-07-16", suggested_open_id: "ou_test1", confidence: "high" },
  ];
  const actions = canonicalizeActions({ jobId, items });
  recordActions(db, jobId, actions);
  const rows = db.prepare("SELECT action_key, payload_hash FROM job_actions WHERE job_id = ? ORDER BY ordinal, id").all(jobId);
  db.prepare(
    "INSERT INTO decisions (id, job_id, decided_by, decision, approved_action_keys_json, ts) VALUES (?,?,?,?,?,?)"
  ).run("d1", jobId, "ou_test1", "approve", JSON.stringify(rows.map((r) => ({ action_key: r.action_key, payload_hash: r.payload_hash }))), 1);
  return { db, jobId };
}

const okLark = async () => ({ exitCode: 0, stdout: "{}", stderr: "" });

describe("runWriteFlow", () => {
  it("spawnPi 失败走 fallback 直执，全成功 → done", async () => {
    const { db, jobId } = seedApprovedJob();
    const bus = createEventBus();
    const buffer = createEventBuffer(db);
    const events = [];
    bus.subscribe(jobId, (e) => events.push(e));
    const out = await runWriteFlow({
      db, config: { enableWrite: true }, startPi: null, bus, buffer,
      writeDeps: {
        runLark: okLark,
        testTarget: { allowOpenIds: new Set(["ou_test1"]), allowTasklist: "" },
        dbPath: ":memory:", writeExtensions: [], piCwd: ".",
        makeSpawnPi: () => async () => { throw new Error("no pi in test"); },
      },
      jobId,
    });
    expect(out.status).toBe("done");
    const statuses = db.prepare("SELECT status FROM job_actions WHERE job_id = ? ORDER BY ordinal, id").all(jobId).map((r) => r.status);
    expect(statuses).toEqual(["succeeded", "succeeded"]);
    expect(events.some((e) => e.event === "job_status" && e.data.status === "running_write")).toBe(true);
    expect(events.some((e) => e.event === "job_status" && e.data.status === "done")).toBe(true);
  });

  it("一条 dry-run 失败 → partial_failed", async () => {
    const { db, jobId } = seedApprovedJob();
    let n = 0;
    const flaky = async (argv) => (argv.includes("--dry-run") && ++n === 2)
      ? { exitCode: 1, stdout: "", stderr: "boom" }
      : { exitCode: 0, stdout: "{}", stderr: "" };
    const bus = createEventBus();
    const buffer = createEventBuffer(db);
    const out = await runWriteFlow({
      db, config: { enableWrite: true }, startPi: null, bus, buffer,
      writeDeps: {
        runLark: flaky,
        testTarget: { allowOpenIds: new Set(["ou_test1"]), allowTasklist: "" },
        dbPath: ":memory:", writeExtensions: [], piCwd: ".",
        makeSpawnPi: () => async () => { throw new Error("no pi"); },
      },
      jobId,
    });
    expect(out.status).toBe("partial_failed");
  });
});

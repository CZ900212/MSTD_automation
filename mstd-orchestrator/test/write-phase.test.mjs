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
});

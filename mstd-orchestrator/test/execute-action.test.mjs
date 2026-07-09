import { describe, it, expect, beforeEach, vi } from "vitest";
import { openDb, migrate } from "../server/db/index.mjs";
import { canonicalizeActions } from "../server/safety/action-dsl.mjs";
import { recordActions, actionsToExecute } from "../server/safety/action-store.mjs";
import { executeApprovedAction, reconcileAction } from "../server/execute/execute-action.mjs";

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
    expect(seen[1]).toContain("job1:" + r.action_key);
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

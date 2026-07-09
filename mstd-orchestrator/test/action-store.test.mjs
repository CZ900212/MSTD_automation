import { describe, it, expect, beforeEach } from "vitest";
import { openDb, migrate } from "../server/db/index.mjs";
import { deriveIdempotencyKey, recordActions, actionsToExecute, markStatus } from "../server/safety/action-store.mjs";

let db;
beforeEach(() => { db = openDb(); migrate(db); });

const actions = [
  { action_key: "k1", kind: "create_task", payload: { title: "a" }, payload_hash: "h1", target_open_id: "ou_a" },
  { action_key: "k2", kind: "create_task", payload: { title: "b" }, payload_hash: "h2", target_open_id: "ou_b" },
];

describe("action-store", () => {
  it("derives idempotency key", () => {
    expect(deriveIdempotencyKey("job1", "k1")).toBe("job1:k1");
  });

  it("records actions as pending with idempotency key", () => {
    recordActions(db, "job1", actions);
    const rows = actionsToExecute(db, "job1");
    expect(rows).toHaveLength(2);
    const keys = rows.map((r) => r.idempotency_key).sort();
    expect(keys).toEqual(["job1:k1", "job1:k2"]);
    expect(rows.every((r) => r.status === "pending")).toBe(true);
  });

  it("recording is idempotent on (job_id, action_key)", () => {
    recordActions(db, "job1", actions);
    expect(() => recordActions(db, "job1", actions)).not.toThrow();
    const count = db.prepare("SELECT COUNT(*) AS n FROM job_actions WHERE job_id='job1'").get().n;
    expect(count).toBe(2);
  });

  it("actionsToExecute returns only pending and failed", () => {
    recordActions(db, "job1", actions);
    const rows = actionsToExecute(db, "job1");
    const byKey = Object.fromEntries(rows.map((r) => [r.action_key, r]));
    markStatus(db, byKey.k1.id, "succeeded", JSON.stringify({ task_id: "t1" }));
    markStatus(db, byKey.k2.id, "failed");
    const retry = actionsToExecute(db, "job1");
    expect(retry.map((r) => r.action_key)).toEqual(["k2"]); // succeeded 排除、failed 保留
  });

  it("excludes executing/unknown from retry set", () => {
    recordActions(db, "job1", actions);
    const rows = actionsToExecute(db, "job1");
    for (const r of rows) {
      markStatus(db, r.id, r.action_key === "k1" ? "executing" : "unknown");
    }
    expect(actionsToExecute(db, "job1")).toHaveLength(0);
  });
});

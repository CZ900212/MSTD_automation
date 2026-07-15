import { describe, it, expect, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { openDb, migrate } from "../server/db/index.mjs";
import { deriveIdempotencyKey, proposalFingerprint, recordActions, actionsToExecute, markStatus } from "../server/safety/action-store.mjs";

function insertJob(db, id) {
  db.prepare(
    `INSERT INTO orch_jobs (id, template_id, title, params_json, status, created_by, thread_ref, created_at, updated_at)
     VALUES (?, ?, NULL, NULL, 'pending', NULL, NULL, ?, ?)`
  ).run(id, "tpl", 1, 1);
}

let db;
beforeEach(() => { db = openDb(); migrate(db); insertJob(db, "job1"); });

const actions = [
  { action_key: "k1", kind: "create_task", payload: { title: "a" }, payload_hash: "h1", target_open_id: "ou_a", requires_open_id: false, ordinal: 0 },
  { action_key: "k2", kind: "create_task", payload: { title: "b" }, payload_hash: "h2", target_open_id: "ou_b", requires_open_id: true, ordinal: 1 },
];

describe("approval provenance migration", () => {
  it("fresh migrate adds approval-provenance columns", () => {
    const actionCols = db.prepare("PRAGMA table_info(job_actions)").all().map((c) => c.name);
    const decisionCols = db.prepare("PRAGMA table_info(decisions)").all().map((c) => c.name);
    const jobCols = db.prepare("PRAGMA table_info(orch_jobs)").all().map((c) => c.name);
    expect(actionCols).toEqual(expect.arrayContaining(["provenance_manifest_json", "provenance_hash"]));
    expect(decisionCols).toContain("provenance_hash_at_decision");
    expect(jobCols).toContain("proposal_fingerprint");
  });

  it("016 upgrades an existing pre-provenance database without losing rows", () => {
    const legacy = openDb();
    const migrationsDir = join(dirname(fileURLToPath(import.meta.url)), "../server/db/migrations");
    legacy.exec(readFileSync(join(migrationsDir, "001_init.sql"), "utf8"));
    legacy.exec(readFileSync(join(migrationsDir, "005_cards.sql"), "utf8"));
    legacy.prepare(
      "INSERT INTO orch_jobs (id, template_id, status, created_at, updated_at) VALUES ('legacy', 't', 'pending', 1, 1)"
    ).run();
    legacy.prepare(
      `INSERT INTO job_actions (id, job_id, action_key, kind, canonical_payload_json, payload_hash, idempotency_key, status, ts)
       VALUES ('old-action', 'legacy', 'k', 'create_task', '{}', 'h', 'i', 'pending', 1)`
    ).run();
    legacy.exec(readFileSync(join(migrationsDir, "016_approval_provenance.sql"), "utf8"));
    const cols = legacy.prepare("PRAGMA table_info(job_actions)").all().map((c) => c.name);
    expect(cols).toEqual(expect.arrayContaining(["provenance_manifest_json", "provenance_hash"]));
    expect(legacy.prepare("SELECT action_key FROM job_actions WHERE id='old-action'").get().action_key).toBe("k");
  });
});

describe("action-store", () => {
  it("derives idempotency key（真机 client_token 长度约束 → 32 hex 确定性短哈希）", () => {
    expect(deriveIdempotencyKey("job1", "k1")).toMatch(/^[0-9a-f]{32}$/);
    expect(deriveIdempotencyKey("job1", "k1")).toBe(deriveIdempotencyKey("job1", "k1"));
    expect(deriveIdempotencyKey("job1", "k1")).not.toBe(deriveIdempotencyKey("job1", "k2"));
  });

  it("records actions as pending with idempotency key and canonical provenance", () => {
    const provenance = { source: { type: "minutes", id: "m1" }, risk: "untrusted raw text" };
    const recorded = recordActions(db, "job1", actions, Date.now(), "sqlite", provenance);
    const rows = actionsToExecute(db, "job1");
    expect(rows).toHaveLength(2);
    const keys = rows.map((r) => r.idempotency_key).sort();
    expect(keys).toEqual([deriveIdempotencyKey("job1", "k1"), deriveIdempotencyKey("job1", "k2")].sort());
    expect(rows.every((r) => r.status === "pending")).toBe(true);
    expect(rows.every((r) => r.provenance_hash === recorded.hash)).toBe(true);
    expect(JSON.parse(rows[0].provenance_manifest_json)).toEqual(provenance);
  });

  it("proposal fingerprint is stable across action-key/job differences, but provenance-sensitive", () => {
    const again = actions.map((a) => ({ ...a, action_key: `${a.action_key}-other-job` }));
    expect(proposalFingerprint(actions, "prov1")).toBe(proposalFingerprint(again, "prov1"));
    expect(proposalFingerprint(actions, "prov1")).not.toBe(proposalFingerprint(actions, "prov2"));
  });

  it("persists ordinal, target_open_id, and requires_open_id", () => {
    recordActions(db, "job1", actions);
    const rows = actionsToExecute(db, "job1");
    const byKey = Object.fromEntries(rows.map((r) => [r.action_key, r]));
    expect(byKey.k1.ordinal).toBe(0);
    expect(byKey.k2.ordinal).toBe(1);
    expect(byKey.k1.target_open_id).toBe("ou_a");
    expect(byKey.k2.target_open_id).toBe("ou_b");
    expect(byKey.k1.requires_open_id).toBe(0);
    expect(byKey.k2.requires_open_id).toBe(1);
  });

  it("recording is idempotent on (job_id, action_key)", () => {
    recordActions(db, "job1", actions);
    expect(() => recordActions(db, "job1", actions)).not.toThrow();
    const count = db.prepare("SELECT COUNT(*) AS n FROM job_actions WHERE job_id='job1'").get().n;
    expect(count).toBe(2);
  });

  it("records two content-identical actions with distinct action_keys as two rows (F4)", () => {
    const dup = [
      { action_key: "kA", kind: "create_task", payload: { title: "same" }, payload_hash: "h", target_open_id: "ou_x", ordinal: 0 },
      { action_key: "kB", kind: "create_task", payload: { title: "same" }, payload_hash: "h", target_open_id: "ou_x", ordinal: 1 },
    ];
    recordActions(db, "job1", dup);
    const count = db.prepare("SELECT COUNT(*) AS n FROM job_actions WHERE job_id='job1'").get().n;
    expect(count).toBe(2);
  });

  it("actionsToExecute orders by ordinal deterministically (unordered input)", () => {
    const shuffled = [
      { action_key: "kZ", kind: "create_task", payload: {}, payload_hash: "h", target_open_id: null, ordinal: 2 },
      { action_key: "kX", kind: "create_task", payload: {}, payload_hash: "h", target_open_id: null, ordinal: 0 },
      { action_key: "kY", kind: "create_task", payload: {}, payload_hash: "h", target_open_id: null, ordinal: 1 },
    ];
    recordActions(db, "job1", shuffled);
    const rows = actionsToExecute(db, "job1");
    expect(rows.map((r) => r.action_key)).toEqual(["kX", "kY", "kZ"]);
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

  it("markStatus without resultJson preserves prior result_json (audit safety)", () => {
    recordActions(db, "job1", actions);
    const rows = actionsToExecute(db, "job1");
    const id = rows.find((r) => r.action_key === "k1").id;
    markStatus(db, id, "failed", JSON.stringify({ error: "boom" }));
    markStatus(db, id, "executing"); // no resultJson arg
    const row = db.prepare("SELECT status, result_json FROM job_actions WHERE id = ?").get(id);
    expect(row.status).toBe("executing");
    expect(row.result_json).toBe(JSON.stringify({ error: "boom" }));
  });
});

import { describe, it, expect } from "vitest";
import { openDb, migrate } from "../server/db/index.mjs";

const TABLES = [
  "users", "orch_jobs", "job_events", "job_draft",
  "decisions", "job_actions", "auth_challenges", "approval_tokens",
];

function insertJob(db, id) {
  db.prepare(
    `INSERT INTO orch_jobs (id, template_id, title, params_json, status, created_by, thread_ref, created_at, updated_at)
     VALUES (?, ?, NULL, NULL, 'pending', NULL, NULL, ?, ?)`
  ).run(id, "tpl", 1, 1);
}

describe("db migrate", () => {
  it("creates all v1 tables", () => {
    const db = openDb();
    migrate(db);
    const names = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table'")
      .all().map((r) => r.name);
    for (const t of TABLES) expect(names).toContain(t);
    db.close();
  });

  it("migrate is idempotent", () => {
    const db = openDb();
    migrate(db);
    expect(() => migrate(db)).not.toThrow();
    db.close();
  });

  it("job_actions enforces UNIQUE(job_id, action_key)", () => {
    const db = openDb();
    migrate(db);
    insertJob(db, "job1");
    const ins = db.prepare(
      `INSERT INTO job_actions (id, job_id, action_key, kind, canonical_payload_json, payload_hash, idempotency_key, status, ts)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );
    ins.run("a1", "job1", "k1", "create_task", "{}", "h", "job1:k1", "pending", 1);
    expect(() =>
      ins.run("a2", "job1", "k1", "create_task", "{}", "h", "job1:k1", "pending", 2)
    ).toThrow(/UNIQUE/i);
    db.close();
  });

  it("job_actions.job_id enforces FK to orch_jobs (orphan insert rejected)", () => {
    const db = openDb();
    migrate(db);
    const ins = db.prepare(
      `INSERT INTO job_actions (id, job_id, action_key, kind, canonical_payload_json, payload_hash, idempotency_key, status, ts)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );
    expect(() =>
      ins.run("a1", "ghost_job", "k1", "create_task", "{}", "h", "ghost_job:k1", "pending", 1)
    ).toThrow(/FOREIGN KEY/i);
    db.close();
  });
});

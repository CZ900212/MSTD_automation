import { describe, it, expect, beforeEach } from "vitest";
import { openDb, migrate } from "../server/db/index.mjs";
import { createJob, getJobRow, getJob, listJobs, updateJobStatus, saveJobDraft } from "../server/store/jobs.mjs";

let db;
beforeEach(() => {
  db = openDb(); migrate(db);
  db.prepare("INSERT INTO users (id, feishu_open_id, name, role, created_at) VALUES (?,?,?,?,?)").run("u-1", "ou_1", "u1", "user", 1);
  db.prepare("INSERT INTO users (id, feishu_open_id, name, role, created_at) VALUES (?,?,?,?,?)").run("u-2", "ou_2", "u2", "user", 1);
});

describe("jobs store", () => {
  it("creates a job with timestamps and returns the row", () => {
    const j = createJob(db, { templateId: "meeting_to_task", title: "会议A", paramsJson: "{}", status: "queued", createdBy: "u-1" }, 100);
    expect(j.id).toBeTruthy();
    expect(j.status).toBe("queued");
    expect(j.created_at).toBe(100);
    expect(j.updated_at).toBe(100);
    expect(getJobRow(db, j.id).title).toBe("会议A");
  });

  it("updateJobStatus bumps updated_at", () => {
    const j = createJob(db, { templateId: "meeting_to_task", status: "running_readonly", createdBy: "u-1" }, 100);
    updateJobStatus(db, j.id, "awaiting_approval", 200);
    const r = getJobRow(db, j.id);
    expect(r.status).toBe("awaiting_approval");
    expect(r.updated_at).toBe(200);
  });

  it("saveJobDraft upserts", () => {
    const j = createJob(db, { templateId: "meeting_to_task", status: "running_readonly", createdBy: "u-1" }, 100);
    saveJobDraft(db, j.id, { cardText: "卡1", itemsJson: "[]", actionSetJson: "[]", rawOutput: "raw" });
    saveJobDraft(db, j.id, { cardText: "卡2" });
    const d = db.prepare("SELECT * FROM job_draft WHERE job_id = ?").get(j.id);
    expect(d.card_text).toBe("卡2");
  });

  it("listJobs filters by status and mine", () => {
    createJob(db, { templateId: "meeting_to_task", status: "awaiting_approval", createdBy: "u-1" }, 100);
    createJob(db, { templateId: "meeting_to_task", status: "done", createdBy: "u-1" }, 101);
    createJob(db, { templateId: "meeting_to_task", status: "awaiting_approval", createdBy: "u-2" }, 102);
    expect(listJobs(db, { status: "awaiting_approval" })).toHaveLength(2);
    expect(listJobs(db, { mine: "u-1" })).toHaveLength(2);
    expect(listJobs(db, { status: "awaiting_approval", mine: "u-1" })).toHaveLength(1);
    expect(listJobs(db, {})).toHaveLength(3);
  });

  it("getJob aggregates events/draft/actions/decisions", () => {
    const j = createJob(db, { templateId: "meeting_to_task", status: "awaiting_approval", createdBy: "u-1" }, 100);
    saveJobDraft(db, j.id, { cardText: "卡" });
    db.prepare("INSERT INTO job_events (id, job_id, phase, seq, type, payload_json, ts) VALUES (?,?,?,?,?,?,?)")
      .run("e1", j.id, "readonly", 1, "tool_start", "{}", 100);
    const detail = getJob(db, j.id);
    expect(detail.job.id).toBe(j.id);
    expect(detail.events).toHaveLength(1);
    expect(detail.draft.card_text).toBe("卡");
    expect(detail.actions).toEqual([]);
    expect(detail.decisions).toEqual([]);
    expect(getJob(db, "missing")).toBeNull();
  });
});

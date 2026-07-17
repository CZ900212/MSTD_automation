import { describe, it, expect } from "vitest";
import { openDb, migrate } from "../server/db/index.mjs";
import { recordTriggerEvent, bindTriggerJob } from "../server/triggers/ingest.mjs";

describe("trigger ingest 幂等", () => {
  it("同 event_id 二次插入 fresh=false；同 dedupe_key 不同 event_id 也 fresh=false", () => {
    const db = openDb(":memory:");
    migrate(db);
    const a = recordTriggerEvent(db, {
      eventKey: "minutes.minute.generated_v1",
      eventId: "e1",
      dedupeKey: "minutes:m1",
    });
    const b = recordTriggerEvent(db, {
      eventKey: "minutes.minute.generated_v1",
      eventId: "e1",
      dedupeKey: "minutes:m1",
    });
    const c = recordTriggerEvent(db, {
      eventKey: "minutes.minute.generated_v1",
      eventId: "e2",
      dedupeKey: "minutes:m1",
    });
    expect(a.fresh).toBe(true);
    expect(b.fresh).toBe(false);
    expect(c.fresh).toBe(false);
  });

  it("bindTriggerJob 将 job_id 绑定到 event", () => {
    const db = openDb(":memory:");
    migrate(db);
    recordTriggerEvent(db, {
      eventKey: "minutes.minute.generated_v1",
      eventId: "e1",
      dedupeKey: "minutes:m1",
    });
    db.prepare(
      `INSERT INTO orch_jobs (id, template_id, title, params_json, status, created_by, thread_ref, created_at, updated_at)
       VALUES (?, ?, NULL, NULL, 'pending', NULL, NULL, ?, ?)`
    ).run("job1", "tpl", 1, 1);
    bindTriggerJob(db, "e1", "job1");
    const row = db.prepare("SELECT job_id FROM orch_events WHERE event_id = ?").get("e1");
    expect(row.job_id).toBe("job1");
  });
});

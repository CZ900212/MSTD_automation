import { describe, it, expect } from "vitest";
import { openDb, migrate } from "../server/db/index.mjs";
import { startMinutesConsumer } from "../server/triggers/minutes-consumer.mjs";

function freshDb() {
  const db = openDb(":memory:");
  migrate(db);
  return db;
}

function fakeSpawn() {
  return {
    stdout: { on: () => {} },
    stderr: { on: () => {} },
    on: () => {},
    kill: () => {},
  };
}

describe("minutes consumer", () => {
  it("同 event_id / 同 minute_token 只建一个 job；坏行不炸", () => {
    const db = freshDb();
    const submitted = [];
    const launcher = {
      submit: (o) => {
        const j = { id: `job${submitted.length + 1}` };
        submitted.push(o);
        // 满足 orch_events.job_id → orch_jobs FK
        db.prepare(
          "INSERT INTO orch_jobs (id, template_id, status, created_at, updated_at) VALUES (?,?,?,?,?)"
        ).run(j.id, "meeting_to_task", "queued", 1, 1);
        return j;
      },
    };
    const c = startMinutesConsumer({
      db,
      launcher,
      larkCli: "lark-cli",
      spawnFn: fakeSpawn,
      log: () => {},
    });
    c.handleLine(JSON.stringify({ event_id: "e1", minute_token: "m1", title: "周会" }));
    c.handleLine(JSON.stringify({ event_id: "e1", minute_token: "m1", title: "周会" }));
    c.handleLine(JSON.stringify({ event_id: "e2", minute_token: "m1", title: "周会" }));
    c.handleLine("not json {{{");
    expect(submitted.length).toBe(1);
    expect(submitted[0]).toMatchObject({
      templateId: "meeting_to_task",
      params: { minute_token: "m1" },
    });
    const bound = db.prepare("SELECT job_id FROM orch_events WHERE event_id = 'e1'").get();
    expect(bound.job_id).toBe("job1");
    c.stop();
  });
});

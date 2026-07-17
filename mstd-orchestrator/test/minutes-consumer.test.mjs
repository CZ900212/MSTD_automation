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
      readPrincipal: { source: "minutes_event", privateDataAuthorized: true },
    });
    const bound = db.prepare("SELECT job_id FROM orch_events WHERE event_id = 'e1'").get();
    expect(bound.job_id).toBe("job1");
    c.stop();
  });

  it("建 job 失败释放 dedupe 墓碑：同一妙记的下一次事件可重试（不再永久封死）", () => {
    const db = freshDb();
    let failFirst = true;
    const submitted = [];
    const launcher = {
      submit: (o) => {
        if (failFirst) { failFirst = false; throw new Error("瞬时故障"); }
        submitted.push(o);
        db.prepare(
          "INSERT INTO orch_jobs (id, template_id, status, created_at, updated_at) VALUES ('job-retry','meeting_to_task','queued',1,1)"
        ).run();
        return { id: "job-retry" };
      },
    };
    const c = startMinutesConsumer({ db, launcher, larkCli: "lark-cli", spawnFn: fakeSpawn, log: () => {} });
    c.handleLine(JSON.stringify({ event_id: "e-fail", minute_token: "m9", title: "周会" }));
    // 修复前：墓碑残留（job_id NULL），同 minute_token 永久不再触发
    expect(db.prepare("SELECT COUNT(*) AS n FROM orch_events WHERE dedupe_key='minutes:m9'").get().n).toBe(0);
    c.handleLine(JSON.stringify({ event_id: "e-retry", minute_token: "m9", title: "周会" }));
    expect(submitted).toHaveLength(1);
    expect(db.prepare("SELECT job_id FROM orch_events WHERE event_id='e-retry'").get().job_id).toBe("job-retry");
    c.stop();
  });

  it("非法 minute_token 在记录事件和启动 job 前被拒绝", () => {
    const db = freshDb();
    const submitted = [];
    const c = startMinutesConsumer({
      db,
      launcher: { submit: (o) => submitted.push(o) },
      larkCli: "lark-cli",
      spawnFn: fakeSpawn,
      log: () => {},
    });
    c.handleLine(JSON.stringify({ event_id: "bad", minute_token: "m1\n越权" }));
    expect(submitted).toEqual([]);
    expect(db.prepare("SELECT COUNT(*) AS n FROM orch_events").get().n).toBe(0);
    c.stop();
  });
});

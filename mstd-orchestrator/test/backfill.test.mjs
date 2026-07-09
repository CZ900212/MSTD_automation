import { describe, it, expect } from "vitest";
import { openDb, migrate } from "../server/db/index.mjs";
import { recordTriggerEvent } from "../server/triggers/ingest.mjs";
import { MINUTES_EVENT_KEY } from "../server/triggers/minutes-consumer.mjs";
import { backfillMinutes } from "../server/triggers/backfill.mjs";

function freshDb() {
  const db = openDb(":memory:");
  migrate(db);
  return db;
}

describe("backfillMinutes", () => {
  it("回扫为未见过的妙记建 job，已消费过的（同 dedupe_key）跳过", async () => {
    const db = freshDb();
    recordTriggerEvent(db, {
      eventKey: MINUTES_EVENT_KEY,
      eventId: "e1",
      dedupeKey: "minutes:m1",
    });
    const submitted = [];
    const launcher = {
      submit: (o) => {
        submitted.push(o);
        const id = `j${submitted.length}`;
        db.prepare(
          "INSERT INTO orch_jobs (id, template_id, status, created_at, updated_at) VALUES (?,?,?,?,?)"
        ).run(id, "meeting_to_task", "queued", 1, 1);
        return { id };
      },
    };
    const runLark = async () => ({
      exitCode: 0,
      stdout: JSON.stringify({
        items: [
          { minute_token: "m1", title: "老会" },
          { minute_token: "m2", title: "新会" },
        ],
      }),
      stderr: "",
    });
    const out = await backfillMinutes({ db, launcher, runLark, log: () => {} });
    expect(out.created).toBe(1);
    expect(submitted[0].params.minute_token).toBe("m2");
  });
});

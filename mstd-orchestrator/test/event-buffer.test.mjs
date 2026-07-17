import { describe, it, expect, beforeEach } from "vitest";
import { openDb, migrate } from "../server/db/index.mjs";
import { createEventBuffer } from "../server/jobs/event-buffer.mjs";

let db;
beforeEach(() => {
  db = openDb(); migrate(db);
  db.prepare("INSERT INTO orch_jobs (id, template_id, status, created_at, updated_at) VALUES (?,?,?,?,?)")
    .run("job1", "meeting_to_task", "running_readonly", 1, 1);
});
const rows = () => db.prepare("SELECT * FROM job_events WHERE job_id='job1' ORDER BY seq").all();

describe("event buffer", () => {
  it("drops non-key events (assistant_delta/thinking_status)", () => {
    const buf = createEventBuffer(db);
    buf.record("job1", "readonly", { event: "assistant_delta", data: { text: "hi" } });
    buf.record("job1", "readonly", { event: "thinking_status", data: { text: "…" } });
    expect(buf.pendingCount).toBe(0);
    buf.flush();
    expect(rows()).toHaveLength(0);
  });
  it("persists key events with monotonic seq", () => {
    const buf = createEventBuffer(db);
    buf.record("job1", "readonly", { event: "tool_start", data: { toolName: "lark" } }, 10);
    buf.record("job1", "readonly", { event: "tool_result", data: { isError: false } }, 11);
    buf.flush();
    const r = rows();
    expect(r.map((x) => x.type)).toEqual(["tool_start", "tool_result"]);
    expect(r.map((x) => x.seq)).toEqual([1, 2]);
    buf.record("job1", "readonly", { event: "message_done", data: {} }, 12);
    buf.flush();
    expect(rows().map((x) => x.seq)).toEqual([1, 2, 3]);
  });
  it("auto-flushes at maxBatch", () => {
    const buf = createEventBuffer(db, { maxBatch: 2 });
    buf.record("job1", "readonly", { event: "job_status", data: { status: "running_readonly" } });
    buf.record("job1", "readonly", { event: "job_status", data: { status: "awaiting_approval" } });
    expect(rows()).toHaveLength(2);
    expect(buf.pendingCount).toBe(0);
  });
  it("flush 遇 DB 异常不抛（定时器回调里抛=崩 daemon）、不丢事件，下一轮重试落库", () => {
    const buf = createEventBuffer(db);
    buf.record("job1", "readonly", { event: "tool_start", data: { toolName: "lark" } }, 10);
    // 制造一次落库失败：违反 job_id 外键
    buf.record("job-不存在", "readonly", { event: "tool_start", data: {} }, 11);
    expect(() => buf.flush()).not.toThrow();
    expect(buf.pendingCount).toBe(2);            // 失败保留 pending，未 splice 丢弃
    expect(rows()).toHaveLength(0);
    // 修复外因后下一轮 flush 成功
    db.prepare("INSERT INTO orch_jobs (id, template_id, status, created_at, updated_at) VALUES ('job-不存在','meeting_to_task','queued',1,1)").run();
    buf.flush();
    expect(buf.pendingCount).toBe(0);
    expect(rows()).toHaveLength(1);
  });

  it("record 即时返回递增 seq，flush 落库同一 seq", () => {
    const buf = createEventBuffer(db);
    const s1 = buf.record("job1", "readonly", { event: "tool_start", data: {} });
    const s2 = buf.record("job1", "readonly", { event: "tool_result", data: {} });
    expect(s1).toBe(1);
    expect(s2).toBe(2);
    expect(buf.record("job1", "readonly", { event: "assistant_delta", data: {} })).toBeNull();
    buf.flush();
    const rows = db.prepare("SELECT seq, type FROM job_events WHERE job_id = 'job1' ORDER BY seq").all();
    expect(rows.map((r) => r.seq)).toEqual([1, 2]);
  });
});

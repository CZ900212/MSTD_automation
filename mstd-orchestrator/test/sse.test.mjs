import { describe, it, expect, beforeEach } from "vitest";
import { sseFormat, streamJobEvents } from "../server/http/sse.mjs";
import { createEventBus } from "../server/jobs/event-bus.mjs";
import { openDb, migrate } from "../server/db/index.mjs";
import { createEventBuffer } from "../server/jobs/event-buffer.mjs";

function fakeRes() {
  const writes = [];
  const handlers = {};
  return {
    writes, headers: null,
    writeHead(_c, h) { this.headers = h; },
    write(s) { writes.push(s); return true; },
    on(ev, fn) { handlers[ev] = fn; },
    _close() { handlers.close?.(); },
  };
}

function seedJobEvent(db, jobId, seq, type, data) {
  db.prepare(
    "INSERT INTO job_events (id, job_id, phase, seq, type, payload_json, ts) VALUES (?,?,?,?,?,?,?)"
  ).run(`e-${jobId}-${seq}`, jobId, "readonly", seq, type, JSON.stringify(data ?? {}), 1);
}

describe("sseFormat", () => {
  it("formats an event frame", () => {
    expect(sseFormat({ event: "tool_start", data: { a: 1 } })).toBe('event: tool_start\ndata: {"a":1}\n\n');
  });

  it("includes id line when seq is present", () => {
    expect(sseFormat({ event: "tool_start", data: { a: 1 }, seq: 5 })).toBe(
      'id: 5\nevent: tool_start\ndata: {"a":1}\n\n'
    );
  });
});

describe("streamJobEvents", () => {
  it("sets SSE headers, forwards published events, heartbeats, and cleans up on close", () => {
    const bus = createEventBus();
    const res = fakeRes();
    let hbFn = null;
    const fakeSetInterval = (fn) => { hbFn = fn; return 123; };
    const cleared = [];
    const fakeClearInterval = (id) => cleared.push(id);

    const close = streamJobEvents({ bus, jobId: "job1", res, heartbeatMs: 15000, setInterval: fakeSetInterval, clearInterval: fakeClearInterval });
    expect(res.headers["Content-Type"]).toBe("text/event-stream");
    expect(bus.subscriberCount("job1")).toBe(1);

    bus.publish("job1", { event: "tool_result", data: { isError: false } });
    expect(res.writes.some((w) => w.includes("event: tool_result"))).toBe(true);

    hbFn();
    expect(res.writes.some((w) => w.startsWith(": ping"))).toBe(true);

    res._close();
    expect(cleared).toContain(123);
    expect(bus.subscriberCount("job1")).toBe(0);
    expect(typeof close).toBe("function");
  });

  describe("sinceSeq replay", () => {
    let db, bus, buffer;
    beforeEach(() => {
      db = openDb();
      migrate(db);
      db.prepare(
        "INSERT INTO orch_jobs (id, template_id, status, created_at, updated_at) VALUES (?,?,?,?,?)"
      ).run("job1", "meeting_to_task", "running_readonly", 1, 1);
      bus = createEventBus();
      buffer = createEventBuffer(db);
    });

    it("重放遇单行损坏 payload_json:降级空 data 继续,不悬死整个流", () => {
      seedJobEvent(db, "job1", 1, "tool_start", { toolName: "lark_read" });
      db.prepare(
        "INSERT INTO job_events (id, job_id, phase, seq, type, payload_json, ts) VALUES (?,?,?,?,?,?,?)"
      ).run("e-job1-2", "job1", "readonly", 2, "message_delta", "{broken", 1);
      seedJobEvent(db, "job1", 3, "message_done", { ok: true });
      const res = fakeRes();
      expect(() => streamJobEvents({
        db, bus, buffer, jobId: "job1", res, sinceSeq: 0, heartbeatMs: 60000,
        setInterval: () => 1, clearInterval: () => {},
      })).not.toThrow();
      const body = res.writes.join("");
      expect(body).toContain("id: 2\nevent: message_delta\ndata: {}"); // 坏行降级空 data
      expect(body).toContain("id: 3\nevent: message_done");            // 后续好行照常补发
    });

    it("回放数据源整体抛错:不留悬挂订阅,连接被清理并收尾", () => {
      const brokenDb = {
        prepare() {
          return { all() { throw new Error("db down"); } };
        },
      };
      const res = fakeRes();
      const cleared = [];
      expect(() => streamJobEvents({
        db: brokenDb, bus, buffer, jobId: "job1", res, sinceSeq: 0, heartbeatMs: 60000,
        setInterval: () => 123, clearInterval: (id) => cleared.push(id),
      })).not.toThrow();
      expect(bus.subscriberCount("job1")).toBe(0); // 订阅未泄漏
      expect(cleared).toContain(123); // 心跳定时器已清
      const body = res.writes.join("");
      expect(body).toContain("event: error");
    });

    it("sinceSeq 重放：先补历史关键事件（带 id 行），再接实时", () => {
      seedJobEvent(db, "job1", 1, "tool_start", { toolName: "lark_read" });
      seedJobEvent(db, "job1", 2, "message_done", {});
      const res = fakeRes();
      streamJobEvents({
        db, bus, buffer, jobId: "job1", res, sinceSeq: 1, heartbeatMs: 60000,
        setInterval: () => 1, clearInterval: () => {},
      });
      const body = res.writes.join("");
      expect(body).toContain("id: 2\nevent: message_done");
      expect(body).not.toContain("id: 1\n"); // seq<=sinceSeq 不补发
      bus.publish("job1", { event: "job_status", data: { status: "done" }, seq: 3 });
      expect(res.writes.join("")).toContain("id: 3\nevent: job_status");
    });
  });
});

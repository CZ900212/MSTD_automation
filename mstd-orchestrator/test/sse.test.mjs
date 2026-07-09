import { describe, it, expect } from "vitest";
import { sseFormat, streamJobEvents } from "../server/http/sse.mjs";
import { createEventBus } from "../server/jobs/event-bus.mjs";

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

describe("sseFormat", () => {
  it("formats an event frame", () => {
    expect(sseFormat({ event: "tool_start", data: { a: 1 } })).toBe('event: tool_start\ndata: {"a":1}\n\n');
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
});

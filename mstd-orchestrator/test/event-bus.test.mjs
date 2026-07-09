import { describe, it, expect } from "vitest";
import { createEventBus } from "../server/jobs/event-bus.mjs";

describe("event bus", () => {
  it("delivers to subscribers of the same job only", () => {
    const bus = createEventBus();
    const a = [], b = [];
    bus.subscribe("job1", (e) => a.push(e));
    bus.subscribe("job2", (e) => b.push(e));
    bus.publish("job1", { event: "tool_start", data: { x: 1 } });
    expect(a).toHaveLength(1);
    expect(b).toHaveLength(0);
  });
  it("unsubscribe stops delivery and cleans up", () => {
    const bus = createEventBus();
    const got = [];
    const off = bus.subscribe("job1", (e) => got.push(e));
    off();
    bus.publish("job1", { event: "message_done", data: {} });
    expect(got).toHaveLength(0);
    expect(bus.subscriberCount("job1")).toBe(0);
  });
  it("one throwing subscriber does not break others", () => {
    const bus = createEventBus();
    const ok = [];
    bus.subscribe("job1", () => { throw new Error("boom"); });
    bus.subscribe("job1", (e) => ok.push(e));
    expect(() => bus.publish("job1", { event: "error", data: {} })).not.toThrow();
    expect(ok).toHaveLength(1);
  });
});

import { describe, it, expect, vi } from "vitest";
import { createDebouncer } from "../server/gateway/debounce.mjs";

describe("debounce", () => {
  it("窗口内连发合并为一次 flush；不同 key 互不影响", () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const flushed = [];
    const d = createDebouncer({ delayMs: 600, maxDelayMs: 3000 });
    d.push("s1|ou_a", { content: "第一条" }, (items, timing) => flushed.push({ items, timing }));
    vi.advanceTimersByTime(400);
    d.push("s1|ou_a", { content: "第二条" }, (items, timing) => flushed.push({ items, timing }));
    d.push("s2|ou_b", { content: "别人" }, (items, timing) => flushed.push({ items, timing }));
    vi.advanceTimersByTime(600);
    expect(flushed).toHaveLength(2);
    const batch = flushed.find((b) => b.items.length === 2);
    expect(batch.items.map((i) => i.content)).toEqual(["第一条", "第二条"]);
    expect(batch.timing).toEqual({ sinceLastMs: 600, batchMs: 1000 });
    vi.useRealTimers();
  });

  it("async flush rejection is reported instead of becoming unhandled", async () => {
    vi.useFakeTimers();
    try {
      const errors = [];
      const d = createDebouncer({
        delayMs: 10,
        onError: (error, context) => errors.push({ error, context }),
      });
      d.push("s1", { content: "x" }, async () => {
        throw new Error("flush failed");
      });

      await vi.advanceTimersByTimeAsync(10);
      expect(errors).toEqual([{
        error: expect.objectContaining({ message: "flush failed" }),
        context: { batchKey: "s1", itemCount: 1 },
      }]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("连续碎片消息最多等待 hard cap，且可按 push 覆盖静默窗口", () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const flushed = [];
    const d = createDebouncer({ delayMs: 600, maxDelayMs: 3000 });
    const push = (n) => d.push("s1", { content: String(n) }, (items, timing) => flushed.push({ items, timing }), { delay: 1500 });
    push(0);
    for (let i = 1; i <= 5; i++) {
      vi.advanceTimersByTime(500);
      push(i);
    }
    vi.advanceTimersByTime(500);
    expect(flushed).toHaveLength(1);
    expect(flushed[0].items).toHaveLength(6);
    expect(flushed[0].timing).toEqual({ sinceLastMs: 500, batchMs: 3000 });
    vi.useRealTimers();
  });
});

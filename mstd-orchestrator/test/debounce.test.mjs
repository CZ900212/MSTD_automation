import { describe, it, expect, vi } from "vitest";
import { createDebouncer } from "../server/gateway/debounce.mjs";

describe("debounce", () => {
  it("窗口内连发合并为一次 flush；不同 key 互不影响", () => {
    vi.useFakeTimers();
    const flushed = [];
    const d = createDebouncer({ delayMs: 3000 });
    d.push("s1|ou_a", { content: "第一条" }, (items) => flushed.push(items));
    vi.advanceTimersByTime(1000);
    d.push("s1|ou_a", { content: "第二条" }, (items) => flushed.push(items));
    d.push("s2|ou_b", { content: "别人" }, (items) => flushed.push(items));
    vi.advanceTimersByTime(3000);
    expect(flushed).toHaveLength(2);
    expect(flushed.find((b) => b.length === 2).map((i) => i.content)).toEqual(["第一条", "第二条"]);
    vi.useRealTimers();
  });
});

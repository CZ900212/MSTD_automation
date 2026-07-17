import { describe, it, expect, vi } from "vitest";
import { createTicker } from "../server/ticker/ticker.mjs";

describe("单 ticker 分频调度", () => {
  it("分频正确、任务抛错不断 ticker、同 tick 串行、stop 幂等", async () => {
    vi.useFakeTimers();
    const runs = { a: 0, b: 0, order: [] };
    const ticker = createTicker({ intervalMs: 1000 });
    ticker.register("everyTick", 1, async () => { runs.a += 1; runs.order.push("a"); });
    ticker.register("everyThree", 3, async () => { runs.b += 1; runs.order.push("b"); });
    ticker.register("boom", 1, async () => { throw new Error("炸"); });
    ticker.start();

    await vi.advanceTimersByTimeAsync(3000);
    expect(runs.a).toBe(3);              // 每 tick 都跑（炸的任务不影响它）
    expect(runs.b).toBe(1);              // 第 3 tick 跑一次
    // 同 tick 内按注册顺序串行（第 3 tick: a 先 b 后）
    expect(runs.order).toEqual(["a", "a", "a", "b"]);

    ticker.stop();
    ticker.stop();                        // 幂等
    await vi.advanceTimersByTimeAsync(3000);
    expect(runs.a).toBe(3);
    vi.useRealTimers();
  });
});

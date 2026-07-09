import { describe, it, expect } from "vitest";
import { createActorPool } from "../server/sessions/actor.mjs";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

describe("session actor", () => {
  it("同 key 串行、异 key 并发、抛错不断队列", async () => {
    const pool = createActorPool();
    const order = [];
    const p1 = pool.enqueue("s1", async () => { await sleep(30); order.push("s1-a"); });
    const p2 = pool.enqueue("s1", async () => { order.push("s1-b"); });
    const p3 = pool.enqueue("s2", async () => { order.push("s2-a"); });
    await Promise.all([p1, p2, p3]);
    expect(order.indexOf("s2-a")).toBeLessThan(order.indexOf("s1-a")); // s2 不等 s1
    expect(order.indexOf("s1-a")).toBeLessThan(order.indexOf("s1-b")); // s1 内串行

    await expect(pool.enqueue("s1", async () => { throw new Error("boom"); })).rejects.toThrow("boom");
    await expect(pool.enqueue("s1", async () => "ok")).resolves.toBe("ok"); // 队列没死
  });
});

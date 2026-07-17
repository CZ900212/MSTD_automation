import { describe, it, expect } from "vitest";
import { createSemaphore, maxConcurrentPi } from "../server/jobs/semaphore.mjs";

describe("maxConcurrentPi", () => {
  it("defaults to 2", () => expect(maxConcurrentPi({})).toBe(2));
  it("clamps to [1,32]（生产 20 并发要求,上限防手滑）", () => {
    expect(maxConcurrentPi({ MSTD_MAX_CONCURRENT_PI: "3" })).toBe(3);
    expect(maxConcurrentPi({ MSTD_MAX_CONCURRENT_PI: "20" })).toBe(20);
    expect(maxConcurrentPi({ MSTD_MAX_CONCURRENT_PI: "99" })).toBe(32);
    expect(maxConcurrentPi({ MSTD_MAX_CONCURRENT_PI: "0" })).toBe(1);
    expect(maxConcurrentPi({ MSTD_MAX_CONCURRENT_PI: "x" })).toBe(2);
  });
});

describe("createSemaphore", () => {
  it("acquires up to max then refuses", () => {
    const s = createSemaphore(2);
    expect(s.tryAcquire()).toBe(true);
    expect(s.tryAcquire()).toBe(true);
    expect(s.tryAcquire()).toBe(false);
    expect(s.active).toBe(2);
  });
  it("release frees a slot", () => {
    const s = createSemaphore(2);
    s.tryAcquire(); s.tryAcquire();
    s.release();
    expect(s.active).toBe(1);
    expect(s.tryAcquire()).toBe(true);
  });
  it("release never goes negative", () => {
    const s = createSemaphore(1);
    s.release();
    expect(s.active).toBe(0);
  });
  it("release 通知所有 onRelease 监听方（共享队列防交叉饥饿）；退订生效；监听器异常不阻断", () => {
    const s = createSemaphore(1);
    const calls = [];
    s.onRelease(() => { throw new Error("pump 内部错误"); });
    s.onRelease(() => calls.push("a"));
    const off = s.onRelease(() => calls.push("b"));
    s.tryAcquire();
    s.release();
    expect(calls).toEqual(["a", "b"]);
    off();
    s.tryAcquire();
    s.release();
    expect(calls).toEqual(["a", "b", "a"]);
  });
});

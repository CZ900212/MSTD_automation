import { describe, it, expect, vi } from "vitest";
import { createBrain, REASON_PROVIDERS } from "../server/models/brain.mjs";

function mockClient() {
  return {
    runJob: vi.fn(async () => ({ finalText: "done" })),
    send: vi.fn(),
    close: vi.fn(async () => {}),
    on: vi.fn(() => () => {}),
  };
}

const store = {
  transcript: () => [{ role: "user", sender_name: "张三", content: "早", ts: 1 }],
};
const session = { id: "s1", version: 0 };

describe("brain（5.5 Pi 会话进程管理）", () => {
  it("同会话两回合复用同一 Pi 进程；空闲计时到点回收", async () => {
    const clients = [];
    const startPi = vi.fn(() => { const c = mockClient(); clients.push(c); return c; });
    const timers = [];
    const brain = createBrain({
      startPi, store, idleMs: 1000,
      sleepFn: async () => {},
      setTimeoutFn: (fn, ms) => { timers.push({ fn, ms }); return timers.length; },
      clearTimeoutFn: () => {},
    });
    await brain.turn({ session, sessionKey: "k1", brief: "问题一" });
    await brain.turn({ session, sessionKey: "k1", brief: "问题二" });
    expect(startPi).toHaveBeenCalledTimes(1);

    // 触发空闲回收
    const idle = timers.at(-1);
    expect(idle.ms).toBe(1000);
    idle.fn();
    expect(clients[0].close).toHaveBeenCalled();
    // 回收后再来回合 → 重新拉起
    await brain.turn({ session, sessionKey: "k1", brief: "问题三" });
    expect(startPi).toHaveBeenCalledTimes(2);
  });

  it("首回合重放 transcript，后续回合不重放", async () => {
    const c = mockClient();
    const brain = createBrain({ startPi: () => c, store, sleepFn: async () => {}, setTimeoutFn: () => 0, clearTimeoutFn: () => {} });
    await brain.turn({ session, sessionKey: "k1", brief: "第一问" });
    expect(c.runJob.mock.calls[0][0]).toContain("张三");
    await brain.turn({ session, sessionKey: "k1", brief: "第二问" });
    expect(c.runJob.mock.calls[1][0]).not.toContain("张三");
  });

  it("steer 在回合中注入 send", async () => {
    const c = mockClient();
    let release;
    c.runJob.mockImplementation(() => new Promise((r) => { release = () => r({ finalText: "ok" }); }));
    const brain = createBrain({ startPi: () => c, store, sleepFn: async () => {}, setTimeoutFn: () => 0, clearTimeoutFn: () => {} });
    const p = brain.turn({ session, sessionKey: "k1", brief: "慢任务" });
    await new Promise((r) => setImmediate(r));
    brain.steer("k1", "补充：改成明天");
    expect(c.send).toHaveBeenCalledWith(expect.objectContaining({ type: "prompt", message: expect.stringContaining("补充：改成明天") }));
    release();
    await p;
  });

  it("spawn 连败 5 次后降级到第二 provider", async () => {
    const attempts = [];
    const startPi = vi.fn((opts) => {
      attempts.push(opts.provider);
      if (opts.provider === REASON_PROVIDERS[0].provider) throw new Error("spawn fail");
      return mockClient();
    });
    const sleepFn = vi.fn(async () => {});
    const brain = createBrain({ startPi, store, sleepFn, setTimeoutFn: () => 0, clearTimeoutFn: () => {} });
    const out = await brain.turn({ session, sessionKey: "k1", brief: "x" });
    expect(out.finalText).toBe("done");
    expect(attempts.filter((p) => p === REASON_PROVIDERS[0].provider)).toHaveLength(5);
    expect(attempts.at(-1)).toBe(REASON_PROVIDERS[1].provider);
    expect(sleepFn).toHaveBeenCalledTimes(5);
  });
});

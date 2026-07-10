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

  it("回合中失败（超时/503）沿链降级：换 provider 重拉重放，同一回合重跑", async () => {
    const spawned = [];
    const startPi = vi.fn((opts) => {
      const c = mockClient();
      if (opts.provider === REASON_PROVIDERS[0].provider) {
        c.runJob = vi.fn(async () => { throw new Error("runJob 超时（provider 503）"); });
      }
      spawned.push({ provider: opts.provider, client: c });
      return c;
    });
    const brain = createBrain({ startPi, store, sleepFn: async () => {}, setTimeoutFn: () => 0, clearTimeoutFn: () => {} });
    const out = await brain.turn({ session, sessionKey: "k1", brief: "重要任务" });
    expect(out.finalText).toBe("done");
    expect(out.providerKey).toBe(REASON_PROVIDERS[1].key);
    // 5.5 的 Pi 已被回收；降级 Pi 首回合带重放历史
    expect(spawned[0].client.close).toHaveBeenCalled();
    const degraded = spawned.find((s) => s.provider === REASON_PROVIDERS[1].provider);
    expect(degraded.client.runJob.mock.calls[0][0]).toContain("张三");
    expect(degraded.client.runJob.mock.calls[0][0]).toContain("重要任务");
  });

  it("onEvent 结构化上报 spawn/turn 两类降级", async () => {
    const events = [];
    // spawn 降级：首 provider 拉不起来
    const startPiSpawn = vi.fn((opts) => {
      if (opts.provider === REASON_PROVIDERS[0].provider) throw new Error("spawn fail");
      return mockClient();
    });
    const b1 = createBrain({ startPi: startPiSpawn, store, retries: 1, sleepFn: async () => {}, setTimeoutFn: () => 0, clearTimeoutFn: () => {}, log: () => {}, onEvent: (e) => events.push(e) });
    await b1.turn({ session, sessionKey: "k1", brief: "x" });
    expect(events).toEqual([expect.objectContaining({
      type: "brain_fallback", phase: "spawn", sessionKey: "k1",
      from: REASON_PROVIDERS[0].key, to: REASON_PROVIDERS[1].key,
    })]);
    expect(events[0].error).toContain("spawn fail");

    // 回合级降级：runJob 失败
    events.length = 0;
    const startPiTurn = vi.fn((opts) => {
      const c = mockClient();
      if (opts.provider === REASON_PROVIDERS[0].provider) {
        c.runJob = vi.fn(async () => { throw new Error("503"); });
      }
      return c;
    });
    const b2 = createBrain({ startPi: startPiTurn, store, sleepFn: async () => {}, setTimeoutFn: () => 0, clearTimeoutFn: () => {}, log: () => {}, onEvent: (e) => { events.push(e); throw new Error("observer boom"); } });
    const out = await b2.turn({ session, sessionKey: "k2", brief: "x" });
    expect(out.finalText).toBe("done");
    expect(events).toEqual([expect.objectContaining({
      type: "brain_fallback", phase: "turn", sessionKey: "k2",
      from: REASON_PROVIDERS[0].key, to: REASON_PROVIDERS[1].key,
    })]);
  });

  it("回合中全链耗尽才抛错", async () => {
    const startPi = vi.fn(() => {
      const c = mockClient();
      c.runJob = vi.fn(async () => { throw new Error("all down"); });
      return c;
    });
    const brain = createBrain({ startPi, store, sleepFn: async () => {}, setTimeoutFn: () => 0, clearTimeoutFn: () => {} });
    await expect(brain.turn({ session, sessionKey: "k1", brief: "x" })).rejects.toThrow(/all down/);
    expect(startPi).toHaveBeenCalledTimes(REASON_PROVIDERS.length);
  });
});

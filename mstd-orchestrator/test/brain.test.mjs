import { describe, it, expect, vi } from "vitest";
import { createBrain, REASON_PROVIDERS } from "../server/models/brain.mjs";
import { createSessionTokenRegistry } from "../server/http/session-tokens.mjs";

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

function deferred() {
  let resolve;
  const promise = new Promise((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

const nextImmediate = () => new Promise((resolve) => setImmediate(resolve));

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

describe("C0.3 会话绑定 token(brain 生命周期)", () => {
  it("spawn 发会话 token 注入 env,空闲回收即吊销", async () => {
    const reg = createSessionTokenRegistry();
    let envSeen;
    const startPi = vi.fn((opts) => { envSeen = opts.env; return mockClient(); });
    const timers = [];
    const brain = createBrain({
      startPi, store, tokens: reg, idleMs: 1000, sleepFn: async () => {},
      setTimeoutFn: (fn, ms) => { timers.push({ fn, ms }); return timers.length; },
      clearTimeoutFn: () => {},
    });
    await brain.turn({ session, sessionKey: "k1", brief: "x" });
    const tok = envSeen.MSTD_INTERNAL_TOKEN;
    expect(typeof tok).toBe("string");
    expect(envSeen.MSTD_SESSION_KEY).toBe("k1");
    expect(reg.resolve(tok)).toBe("k1");
    timers.at(-1).fn();                       // 空闲回收
    await new Promise((r) => setImmediate(r));
    expect(reg.resolve(tok)).toBeNull();      // 已吊销
  });

  it("每次 startPi 尝试用不同 token;失败尝试立即吊销", async () => {
    const reg = createSessionTokenRegistry();
    const seen = [];
    const startPi = vi.fn(({ env }) => {
      seen.push(env.MSTD_INTERNAL_TOKEN);
      if (seen.length < 3) throw new Error("spawn fail");
      return mockClient();
    });
    const brain = createBrain({ startPi, store, tokens: reg, retries: 3, sleepFn: async () => {}, setTimeoutFn: () => 0, clearTimeoutFn: () => {} });
    await brain.turn({ session, sessionKey: "k1", brief: "x" });
    expect(new Set(seen).size).toBe(3);
    expect(reg.resolve(seen[0])).toBeNull();
    expect(reg.resolve(seen[1])).toBeNull();
    expect(reg.resolve(seen[2])).toBe("k1");
  });

  it("所有 provider 全部拉起失败:已签发 token 全部吊销", async () => {
    const reg = createSessionTokenRegistry();
    const seen = [];
    const startPi = vi.fn(({ env }) => {
      seen.push(env.MSTD_INTERNAL_TOKEN);
      throw new Error("spawn fail");
    });
    const brain = createBrain({ startPi, store, tokens: reg, retries: 1, sleepFn: async () => {}, setTimeoutFn: () => 0, clearTimeoutFn: () => {}, log: () => {} });
    await expect(brain.turn({ session, sessionKey: "k1", brief: "x" })).rejects.toThrow(/拉起失败/);
    expect(seen).toHaveLength(REASON_PROVIDERS.length);
    for (const tok of seen) expect(reg.resolve(tok)).toBeNull();
  });

  it("回合降级回收旧 Pi 时旧 token 吊销,新 Pi 使用新 token", async () => {
    const reg = createSessionTokenRegistry();
    const seen = [];
    const startPi = vi.fn((opts) => {
      seen.push(opts.env.MSTD_INTERNAL_TOKEN);
      const c = mockClient();
      if (opts.provider === REASON_PROVIDERS[0].provider) {
        c.runJob = vi.fn(async () => { throw new Error("503"); });
      }
      return c;
    });
    const brain = createBrain({ startPi, store, tokens: reg, sleepFn: async () => {}, setTimeoutFn: () => 0, clearTimeoutFn: () => {}, log: () => {} });
    const out = await brain.turn({ session, sessionKey: "k1", brief: "x" });
    expect(out.finalText).toBe("done");
    expect(seen).toHaveLength(2);
    expect(seen[0]).not.toBe(seen[1]);
    await new Promise((r) => setImmediate(r));
    expect(reg.resolve(seen[0])).toBeNull();  // 被回收的 5.5 Pi
    expect(reg.resolve(seen[1])).toBe("k1");  // 降级 Pi 持新 token
  });

  it("spawn-after-shutdown:startPi 成功但已关停,该 Pi 关闭且 token 吊销", async () => {
    const reg = createSessionTokenRegistry();
    const client = mockClient();
    let brain;
    let shutdownPromise;
    let tokAtSpawn;
    const startPi = vi.fn(({ env }) => {
      tokAtSpawn = env.MSTD_INTERNAL_TOKEN;
      shutdownPromise = brain.shutdown();   // spawn 中同步重入关停
      return client;
    });
    brain = createBrain({ startPi, store, tokens: reg, sleepFn: async () => {}, setTimeoutFn: () => 0, clearTimeoutFn: () => {} });
    const outcome = brain._ensure("k1").then(
      (value) => ({ status: "fulfilled", value }),
      (error) => ({ status: "rejected", error }),
    );
    await shutdownPromise;
    const ensured = await outcome;
    expect(ensured.status).toBe("rejected");
    expect(client.close).toHaveBeenCalledTimes(1);
    expect(reg.resolve(tokAtSpawn)).toBeNull();   // spawn-after-shutdown 路径也吊销
  });

  it("shutdown 吊销存活 Pi 的 token", async () => {
    const reg = createSessionTokenRegistry();
    let envSeen;
    const startPi = vi.fn((opts) => { envSeen = opts.env; return mockClient(); });
    const brain = createBrain({ startPi, store, tokens: reg, sleepFn: async () => {}, setTimeoutFn: () => 0, clearTimeoutFn: () => {} });
    await brain.turn({ session, sessionKey: "k1", brief: "x" });
    const tok = envSeen.MSTD_INTERNAL_TOKEN;
    expect(reg.resolve(tok)).toBe("k1");
    await brain.shutdown();
    expect(reg.resolve(tok)).toBeNull();
  });
});

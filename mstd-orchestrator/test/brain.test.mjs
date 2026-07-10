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

  it("C0.2 A：同 key turn 在前一回合完成前严格串行", async () => {
    const firstGate = deferred();
    const order = [];
    const c = mockClient();
    c.runJob = vi.fn(async (prompt) => {
      if (prompt.includes("第一回合")) {
        await firstGate.promise;
        order.push("t1");
        return { finalText: "first" };
      }
      order.push("t2");
      return { finalText: "second" };
    });
    const startPi = vi.fn(() => c);
    const brain = createBrain({
      startPi,
      store,
      sleepFn: async () => {},
      setTimeoutFn: () => 0,
      clearTimeoutFn: () => {},
    });
    let p1;
    let p2;

    try {
      p1 = brain.turn({ session, sessionKey: "serial-key", brief: "第一回合" });
      p2 = brain.turn({ session, sessionKey: "serial-key", brief: "第二回合" });
      await vi.waitFor(() => expect(c.runJob).toHaveBeenCalledTimes(1));

      expect(startPi).toHaveBeenCalledTimes(1);
      expect(c.runJob).toHaveBeenCalledTimes(1);

      firstGate.resolve();
      const [first, second] = await Promise.all([p1, p2]);
      expect(first.finalText).toBe("first");
      expect(second.finalText).toBe("second");
      expect(order).toEqual(["t1", "t2"]);
    } finally {
      firstGate.resolve();
      await Promise.allSettled([p1, p2].filter(Boolean));
      await brain.shutdown();
    }
  });

  it("C0.2 B：首 turn 全链 reject 后第二 turn 继续且 tail 清理", async () => {
    const firstGate = deferred();
    let firstStarts = 0;
    let secondStarts = 0;
    const startPi = vi.fn(() => {
      const c = mockClient();
      c.runJob = vi.fn(async (prompt) => {
        if (prompt.includes("首回合全链失败")) {
          firstStarts += 1;
          if (firstStarts === 1) await firstGate.promise;
          throw new Error(`first chain down ${firstStarts}`);
        }
        if (prompt.includes("第二回合继续")) {
          secondStarts += 1;
          return { finalText: "recovered" };
        }
        throw new Error("unexpected prompt");
      });
      return c;
    });
    const brain = createBrain({
      startPi,
      store,
      sleepFn: async () => {},
      setTimeoutFn: () => 0,
      clearTimeoutFn: () => {},
      log: () => {},
    });
    let firstOutcome;
    let secondOutcome;

    try {
      const p1 = brain.turn({ session, sessionKey: "reject-key", brief: "首回合全链失败" });
      firstOutcome = p1.then(
        (value) => ({ status: "fulfilled", value }),
        (error) => ({ status: "rejected", error }),
      );
      await vi.waitFor(() => expect(firstStarts).toBe(1));

      const p2 = brain.turn({ session, sessionKey: "reject-key", brief: "第二回合继续" });
      secondOutcome = p2.then(
        (value) => ({ status: "fulfilled", value }),
        (error) => ({ status: "rejected", error }),
      );
      await nextImmediate();
      await nextImmediate();

      expect(secondStarts).toBe(0);

      firstGate.resolve();
      const [first, second] = await Promise.all([firstOutcome, secondOutcome]);
      expect(first.status).toBe("rejected");
      expect(first.error).toBeInstanceOf(Error);
      expect(first.error.message).toContain("first chain down");
      expect(firstStarts).toBe(REASON_PROVIDERS.length);
      expect(second).toEqual(expect.objectContaining({
        status: "fulfilled",
        value: expect.objectContaining({ finalText: "recovered" }),
      }));
      expect(secondStarts).toBe(1);
      expect(startPi).toHaveBeenCalledTimes(REASON_PROVIDERS.length + 1);

      await nextImmediate();
      expect(brain._turnTails).toBeInstanceOf(Map);
      expect(brain._turnTails.size).toBe(0);
    } finally {
      firstGate.resolve();
      await Promise.allSettled([firstOutcome, secondOutcome].filter(Boolean));
      await brain.shutdown();
    }
  });

  it("C0.2 C：不同 key 的 turn 保持并行", async () => {
    const gates = new Map([
      ["parallel-a", deferred()],
      ["parallel-b", deferred()],
    ]);
    const entered = [];
    const startPi = vi.fn((opts) => {
      const key = opts.env.MSTD_SESSION_KEY;
      const c = mockClient();
      c.runJob = vi.fn(async () => {
        entered.push(key);
        await gates.get(key).promise;
        return { finalText: key };
      });
      return c;
    });
    const brain = createBrain({
      startPi,
      store,
      sleepFn: async () => {},
      setTimeoutFn: () => 0,
      clearTimeoutFn: () => {},
    });
    const p1 = brain.turn({ session: { ...session, id: "parallel-session-a" }, sessionKey: "parallel-a", brief: "A" });
    const p2 = brain.turn({ session: { ...session, id: "parallel-session-b" }, sessionKey: "parallel-b", brief: "B" });

    try {
      await vi.waitFor(() => {
        expect(entered).toHaveLength(2);
        expect(entered).toEqual(expect.arrayContaining(["parallel-a", "parallel-b"]));
      });

      gates.get("parallel-a").resolve();
      gates.get("parallel-b").resolve();
      const [out1, out2] = await Promise.all([p1, p2]);
      expect(out1.finalText).toBe("parallel-a");
      expect(out2.finalText).toBe("parallel-b");
    } finally {
      gates.get("parallel-a").resolve();
      gates.get("parallel-b").resolve();
      await Promise.allSettled([p1, p2]);
      await brain.shutdown();
    }
  });

  it("C0.2 D：steer/isBusy 始终指向同 key 当前运行回合而非排队回合", async () => {
    const firstGate = deferred();
    const secondGate = deferred();
    const c = mockClient();
    c.runJob = vi.fn()
      .mockImplementationOnce(async () => {
        await firstGate.promise;
        return { finalText: "first" };
      })
      .mockImplementationOnce(async () => {
        await secondGate.promise;
        return { finalText: "second" };
      });
    const brain = createBrain({
      startPi: () => c,
      store,
      sleepFn: async () => {},
      setTimeoutFn: () => 0,
      clearTimeoutFn: () => {},
    });
    let p1;
    let p2;

    try {
      p1 = brain.turn({ session, sessionKey: "steer-key", brief: "运行回合" });
      await vi.waitFor(() => expect(c.runJob).toHaveBeenCalledTimes(1));
      p2 = brain.turn({ session, sessionKey: "steer-key", brief: "排队回合" });
      await nextImmediate();
      await nextImmediate();

      expect(c.runJob).toHaveBeenCalledTimes(1);
      expect(brain.isBusy("steer-key")).toBe(true);
      expect(brain.steer("steer-key", "给第一回合")).toBe(true);
      expect(c.send).toHaveBeenLastCalledWith(expect.objectContaining({
        type: "prompt",
        message: expect.stringContaining("给第一回合"),
      }));

      firstGate.resolve();
      await p1;
      await vi.waitFor(() => expect(c.runJob).toHaveBeenCalledTimes(2));
      expect(brain.isBusy("steer-key")).toBe(true);
      expect(brain.steer("steer-key", "给第二回合")).toBe(true);
      expect(c.send).toHaveBeenLastCalledWith(expect.objectContaining({
        type: "prompt",
        message: expect.stringContaining("给第二回合"),
      }));

      secondGate.resolve();
      await p2;
      expect(brain.isBusy("steer-key")).toBe(false);
      expect(brain.steer("steer-key", "回合外插话")).toBe(false);
      expect(c.send).toHaveBeenCalledTimes(2);
    } finally {
      firstGate.resolve();
      secondGate.resolve();
      await Promise.allSettled([p1, p2].filter(Boolean));
      await brain.shutdown();
    }
  });

  it("C0.2 E：复用 Pi 时 clear 非零 idle timer 并在回合后 rearm", async () => {
    const secondGate = deferred();
    let nextHandle = 101;
    const setTimeoutFn = vi.fn(() => nextHandle++);
    const clearTimeoutFn = vi.fn();
    const client = mockClient();
    client.runJob
      .mockImplementationOnce(async () => ({ finalText: "first" }))
      .mockImplementationOnce(async () => {
        await secondGate.promise;
        return { finalText: "second" };
      });
    const brain = createBrain({
      startPi: () => client,
      store,
      idleMs: 1_000,
      sleepFn: async () => {},
      setTimeoutFn,
      clearTimeoutFn,
    });
    let secondTurn;

    try {
      await brain.turn({ session, sessionKey: "timer-key", brief: "第一回合" });
      expect(setTimeoutFn).toHaveBeenCalledTimes(1);
      expect(setTimeoutFn.mock.results[0].value).toBe(101);
      expect(brain._pool.get("timer-key").idleTimer).toBe(101);

      secondTurn = brain.turn({ session, sessionKey: "timer-key", brief: "第二回合" });
      await vi.waitFor(() => expect(client.runJob).toHaveBeenCalledTimes(2));
      expect(clearTimeoutFn).toHaveBeenCalledTimes(1);
      expect(clearTimeoutFn).toHaveBeenCalledWith(101);
      expect(setTimeoutFn).toHaveBeenCalledTimes(1);
      expect(brain._pool.get("timer-key").idleTimer).toBeNull();

      secondGate.resolve();
      await secondTurn;
      expect(setTimeoutFn).toHaveBeenCalledTimes(2);
      expect(setTimeoutFn.mock.results.map(({ value }) => value)).toEqual([101, 102]);
      expect(setTimeoutFn.mock.results.every(({ value }) => value !== 0)).toBe(true);
      expect(brain._pool.get("timer-key").idleTimer).toBe(102);
    } finally {
      secondGate.resolve();
      await Promise.allSettled([secondTurn].filter(Boolean));
      await brain.shutdown();
    }
  });

  it("C0.2 F：同 key 并发 ensure 合并为同一条 semaphore/spawn 链", async () => {
    const acquireGate = deferred();
    const semaphore = {
      tryAcquire: vi.fn()
        .mockReturnValueOnce(false)
        .mockReturnValue(true),
      release: vi.fn(),
    };
    const sleepFn = vi.fn(() => acquireGate.promise);
    const client = mockClient();
    const startPi = vi.fn(() => client);
    const brain = createBrain({
      startPi,
      store,
      semaphore,
      sleepFn,
      setTimeoutFn: () => 0,
      clearTimeoutFn: () => {},
    });
    let p1;
    let p2;

    try {
      expect(brain._ensure).toEqual(expect.any(Function));

      p1 = brain._ensure("ensure-key");
      await vi.waitFor(() => expect(sleepFn).toHaveBeenCalledTimes(1));
      p2 = brain._ensure("ensure-key");
      await nextImmediate();

      expect(semaphore.tryAcquire).toHaveBeenCalledTimes(1);
      expect(startPi).not.toHaveBeenCalled();

      acquireGate.resolve();
      const [entry1, entry2] = await Promise.all([p1, p2]);
      expect(entry1).toBe(entry2);
      expect(semaphore.tryAcquire).toHaveBeenCalledTimes(2);
      expect(startPi).toHaveBeenCalledTimes(1);
    } finally {
      acquireGate.resolve();
      await Promise.allSettled([p1, p2].filter(Boolean));
      await brain.shutdown();
    }
  });

  it("C0.2 F2：合并的 ensure 失败后清理 in-flight，并允许同 key 重新 spawn", async () => {
    const firstFailureGate = deferred();
    const semaphore = {
      tryAcquire: vi.fn(() => true),
      release: vi.fn(),
    };
    let failSpawn = true;
    const client = mockClient();
    const startPi = vi.fn(() => {
      if (failSpawn) throw new Error("spawn chain failed");
      return client;
    });
    const sleepFn = vi.fn(() => (
      sleepFn.mock.calls.length === 1
        ? firstFailureGate.promise
        : Promise.resolve()
    ));
    const brain = createBrain({
      startPi,
      store,
      semaphore,
      retries: 1,
      sleepFn,
      setTimeoutFn: () => 0,
      clearTimeoutFn: () => {},
      log: () => {},
    });
    let firstOutcome;
    let secondOutcome;
    let thirdEnsure;

    try {
      expect(brain._ensure).toEqual(expect.any(Function));

      const p1 = brain._ensure("ensure-retry-key");
      firstOutcome = p1.then(
        (value) => ({ status: "fulfilled", value }),
        (error) => ({ status: "rejected", error }),
      );
      await vi.waitFor(() => {
        expect(semaphore.tryAcquire).toHaveBeenCalledTimes(1);
        expect(startPi).toHaveBeenCalledTimes(1);
        expect(sleepFn).toHaveBeenCalledTimes(1);
      });

      const p2 = brain._ensure("ensure-retry-key");
      secondOutcome = p2.then(
        (value) => ({ status: "fulfilled", value }),
        (error) => ({ status: "rejected", error }),
      );
      await nextImmediate();

      expect(semaphore.tryAcquire).toHaveBeenCalledTimes(1);
      expect(startPi).toHaveBeenCalledTimes(1);

      firstFailureGate.resolve();
      const [first, second] = await Promise.all([firstOutcome, secondOutcome]);
      expect(first.status).toBe("rejected");
      expect(first.error).toBeInstanceOf(Error);
      expect(first.error.message).toContain("spawn chain failed");
      expect(second.status).toBe("rejected");
      expect(second.error).toBeInstanceOf(Error);
      expect(second.error.message).toContain("spawn chain failed");
      expect(startPi).toHaveBeenCalledTimes(REASON_PROVIDERS.length);
      expect(startPi.mock.calls.map(([opts]) => opts.provider)).toEqual(
        REASON_PROVIDERS.map(({ provider }) => provider),
      );
      expect(semaphore.release).toHaveBeenCalledTimes(1);

      failSpawn = false;
      thirdEnsure = brain._ensure("ensure-retry-key");
      const entry = await thirdEnsure;
      expect(entry.client).toBe(client);
      expect(semaphore.tryAcquire).toHaveBeenCalledTimes(2);
      expect(startPi).toHaveBeenCalledTimes(REASON_PROVIDERS.length + 1);
      expect(startPi.mock.calls.at(-1)[0].provider).toBe(REASON_PROVIDERS[0].provider);
      expect(semaphore.release).toHaveBeenCalledTimes(1);
    } finally {
      firstFailureGate.resolve();
      await Promise.allSettled([firstOutcome, secondOutcome, thirdEnsure].filter(Boolean));
      await brain.shutdown();
    }
  });

  it("C0.2 P1：shutdown 封禁排队回合和后续新回合，不允许 pool 复活", async () => {
    const firstGate = deferred();
    const client = mockClient();
    client.runJob.mockImplementationOnce(async () => {
      await firstGate.promise;
      return { finalText: "first" };
    });
    const startPi = vi.fn(() => client);
    const brain = createBrain({
      startPi,
      store,
      sleepFn: async () => {},
      setTimeoutFn: () => 0,
      clearTimeoutFn: () => {},
    });
    let firstOutcome;
    let queuedOutcome;
    let newOutcome;

    try {
      const p1 = brain.turn({ session, sessionKey: "shutdown-key", brief: "运行中" });
      firstOutcome = p1.then(
        (value) => ({ status: "fulfilled", value }),
        (error) => ({ status: "rejected", error }),
      );
      await vi.waitFor(() => expect(client.runJob).toHaveBeenCalledTimes(1));

      const p2 = brain.turn({ session, sessionKey: "shutdown-key", brief: "排队中" });
      queuedOutcome = p2.then(
        (value) => ({ status: "fulfilled", value }),
        (error) => ({ status: "rejected", error }),
      );
      await nextImmediate();
      await nextImmediate();
      expect(client.runJob).toHaveBeenCalledTimes(1);

      await brain.shutdown();
      expect(brain._pool.size).toBe(0);

      const p3 = brain.turn({ session, sessionKey: "after-shutdown-key", brief: "关闭后新回合" });
      newOutcome = p3.then(
        (value) => ({ status: "fulfilled", value }),
        (error) => ({ status: "rejected", error }),
      );

      firstGate.resolve();
      const [first, queued, afterShutdown] = await Promise.all([firstOutcome, queuedOutcome, newOutcome]);
      expect(first).toEqual(expect.objectContaining({
        status: "fulfilled",
        value: expect.objectContaining({ finalText: "first" }),
      }));
      expect(queued.status).toBe("rejected");
      expect(queued.error).toBeInstanceOf(Error);
      expect(queued.error.message).toMatch(/brain.*关闭|closed|shut(?:ting)? down/i);
      expect(afterShutdown.status).toBe("rejected");
      expect(afterShutdown.error).toBeInstanceOf(Error);
      expect(afterShutdown.error.message).toMatch(/brain.*关闭|closed|shut(?:ting)? down/i);
      expect(startPi).toHaveBeenCalledTimes(1);
      expect(brain._pool.size).toBe(0);

      await nextImmediate();
      expect(brain._turnTails.size).toBe(0);
    } finally {
      firstGate.resolve();
      await Promise.allSettled([firstOutcome, queuedOutcome, newOutcome].filter(Boolean));
      await brain.shutdown();
    }
  });

  it("C0.2 P2：semaphore 等待期间 shutdown 后不再 acquire 或 spawn", async () => {
    const waitGate = deferred();
    const semaphore = {
      tryAcquire: vi.fn()
        .mockReturnValueOnce(false)
        .mockReturnValue(true),
      release: vi.fn(),
    };
    const startPi = vi.fn(() => mockClient());
    const sleepFn = vi.fn(() => waitGate.promise);
    const brain = createBrain({
      startPi,
      store,
      semaphore,
      sleepFn,
      setTimeoutFn: () => 0,
      clearTimeoutFn: () => {},
    });
    let ensureOutcome;

    try {
      const pending = brain._ensure("shutdown-wait-key");
      ensureOutcome = pending.then(
        (value) => ({ status: "fulfilled", value }),
        (error) => ({ status: "rejected", error }),
      );
      await vi.waitFor(() => expect(sleepFn).toHaveBeenCalledTimes(1));

      await brain.shutdown();
      waitGate.resolve();
      const result = await ensureOutcome;

      expect(result.status).toBe("rejected");
      expect(result.error).toBeInstanceOf(Error);
      expect(result.error.message).toMatch(/brain.*关闭|closed|shut(?:ting)? down/i);
      expect(semaphore.tryAcquire).toHaveBeenCalledTimes(1);
      expect(semaphore.release).not.toHaveBeenCalled();
      expect(startPi).not.toHaveBeenCalled();
      expect(brain._pool.size).toBe(0);
    } finally {
      waitGate.resolve();
      await Promise.allSettled([ensureOutcome].filter(Boolean));
      await brain.shutdown();
    }
  });

  it("C0.2 P3：shutdown 关闭已创建但尚未入 pool 的 client，并单次 release", async () => {
    const closeGate = deferred();
    const semaphore = {
      tryAcquire: vi.fn(() => true),
      release: vi.fn(),
    };
    const client = mockClient();
    client.close.mockImplementationOnce(() => closeGate.promise);
    const startPi = vi.fn(() => client);
    const brain = createBrain({
      startPi,
      store,
      semaphore,
      sleepFn: async () => {},
      setTimeoutFn: () => 0,
      clearTimeoutFn: () => {},
    });
    let ensureOutcome;
    let shutdownPromise;
    let shutdownSettled = false;

    try {
      const pending = brain._ensure("shutdown-spawn-key");
      ensureOutcome = pending.then(
        (value) => ({ status: "fulfilled", value }),
        (error) => ({ status: "rejected", error }),
      );
      expect(startPi).toHaveBeenCalledTimes(1);

      shutdownPromise = brain.shutdown();
      shutdownPromise.then(
        () => { shutdownSettled = true; },
        () => { shutdownSettled = true; },
      );
      await vi.waitFor(() => expect(client.close).toHaveBeenCalledTimes(1));
      await nextImmediate();

      expect(shutdownSettled).toBe(false);
      expect(semaphore.release).not.toHaveBeenCalled();

      closeGate.resolve();
      await shutdownPromise;
      const result = await ensureOutcome;

      expect(result.status).toBe("rejected");
      expect(result.error).toBeInstanceOf(Error);
      expect(result.error.message).toMatch(/brain.*关闭|closed|shut(?:ting)? down/i);
      expect(client.close).toHaveBeenCalledTimes(1);
      expect(semaphore.release).toHaveBeenCalledTimes(1);
      expect(brain._pool.size).toBe(0);
    } finally {
      closeGate.resolve();
      await Promise.allSettled([ensureOutcome, shutdownPromise].filter(Boolean));
      await Promise.allSettled([brain.shutdown()]);
    }
  });

  it("C0.2 P4：运行回合与 shutdown 竞态不 fallback 或 double close/release", async () => {
    let rejectRun;
    const runGate = new Promise((_, reject) => { rejectRun = reject; });
    const semaphore = {
      tryAcquire: vi.fn(() => true),
      release: vi.fn(),
    };
    const client = mockClient();
    client.runJob.mockImplementationOnce(() => runGate);
    const startPi = vi.fn(() => client);
    const brain = createBrain({
      startPi,
      store,
      semaphore,
      sleepFn: async () => {},
      setTimeoutFn: () => 0,
      clearTimeoutFn: () => {},
      log: () => {},
    });
    let turnOutcome;

    try {
      const pending = brain.turn({ session, sessionKey: "shutdown-fail-key", brief: "运行后失败" });
      turnOutcome = pending.then(
        (value) => ({ status: "fulfilled", value }),
        (error) => ({ status: "rejected", error }),
      );
      await vi.waitFor(() => expect(client.runJob).toHaveBeenCalledTimes(1));

      await brain.shutdown();
      rejectRun(new Error("run failed after shutdown"));
      const result = await turnOutcome;

      expect(result.status).toBe("rejected");
      expect(result.error).toBeInstanceOf(Error);
      expect(result.error.message).toContain("run failed after shutdown");
      expect(startPi).toHaveBeenCalledTimes(1);
      expect(client.close).toHaveBeenCalledTimes(1);
      expect(semaphore.release).toHaveBeenCalledTimes(1);
      expect(brain._pool.size).toBe(0);
    } finally {
      rejectRun?.(new Error("test cleanup"));
      await Promise.allSettled([turnOutcome].filter(Boolean));
      await brain.shutdown();
    }
  });

  it("C0.2 P5：runJob fallback 等 client.close 完成后才 release 并拉下一 provider", async () => {
    const closeGate = deferred();
    let permits = 1;
    const semaphore = {
      tryAcquire: vi.fn(() => {
        if (permits === 0) return false;
        permits -= 1;
        return true;
      }),
      release: vi.fn(() => { permits += 1; }),
    };
    const first = mockClient();
    first.runJob.mockRejectedValueOnce(new Error("first provider down"));
    first.close.mockImplementationOnce(() => closeGate.promise);
    const second = mockClient();
    const startPi = vi.fn((opts) => (
      opts.provider === REASON_PROVIDERS[0].provider ? first : second
    ));
    const brain = createBrain({
      startPi,
      store,
      semaphore,
      sleepFn: async () => {},
      setTimeoutFn: () => 0,
      clearTimeoutFn: () => {},
      log: () => {},
    });
    let turnPromise;

    try {
      turnPromise = brain.turn({ session, sessionKey: "fallback-close-key", brief: "fallback" });
      await vi.waitFor(() => expect(first.close).toHaveBeenCalledTimes(1));
      await nextImmediate();

      expect(semaphore.release).not.toHaveBeenCalled();
      expect(startPi).toHaveBeenCalledTimes(1);

      closeGate.resolve();
      const result = await turnPromise;
      expect(result.providerKey).toBe(REASON_PROVIDERS[1].key);
      expect(startPi).toHaveBeenCalledTimes(2);
      expect(semaphore.release).toHaveBeenCalledTimes(1);
    } finally {
      closeGate.resolve();
      await Promise.allSettled([turnPromise].filter(Boolean));
      await brain.shutdown();
    }
  });

  it("C0.2 P6：idle recycle 等 client.close 完成后才 release permit", async () => {
    const closeGate = deferred();
    let permits = 1;
    const semaphore = {
      tryAcquire: vi.fn(() => {
        if (permits === 0) return false;
        permits -= 1;
        return true;
      }),
      release: vi.fn(() => { permits += 1; }),
    };
    const first = mockClient();
    first.close.mockImplementationOnce(() => closeGate.promise);
    const second = mockClient();
    const clients = [first, second];
    const startPi = vi.fn(() => clients.shift());
    const timers = [];
    const brain = createBrain({
      startPi,
      store,
      semaphore,
      sleepFn: () => closeGate.promise,
      setTimeoutFn: (fn) => {
        timers.push(fn);
        return timers.length;
      },
      clearTimeoutFn: () => {},
    });
    let secondTurn;

    try {
      await brain.turn({ session, sessionKey: "idle-close-key", brief: "first" });
      timers.at(-1)();
      secondTurn = brain.turn({ session, sessionKey: "idle-close-key", brief: "second" });
      await vi.waitFor(() => expect(first.close).toHaveBeenCalledTimes(1));
      await nextImmediate();

      expect(semaphore.release).not.toHaveBeenCalled();
      expect(startPi).toHaveBeenCalledTimes(1);

      closeGate.resolve();
      await secondTurn;
      expect(startPi).toHaveBeenCalledTimes(2);
      expect(semaphore.release).toHaveBeenCalledTimes(1);
    } finally {
      closeGate.resolve();
      await Promise.allSettled([secondTurn].filter(Boolean));
      await brain.shutdown();
    }
  });

  it("C0.2 P7：shutdown 即使一个 close reject 也清理并 release 全部 entry", async () => {
    const semaphore = {
      tryAcquire: vi.fn(() => true),
      release: vi.fn(),
    };
    const first = mockClient();
    first.close.mockRejectedValueOnce(new Error("first close failed"));
    const second = mockClient();
    const startPi = vi.fn((opts) => (
      opts.env.MSTD_SESSION_KEY === "shutdown-all-a" ? first : second
    ));
    const brain = createBrain({
      startPi,
      store,
      semaphore,
      sleepFn: async () => {},
      setTimeoutFn: () => 0,
      clearTimeoutFn: () => {},
    });
    let shutdownPromise;

    try {
      await brain.turn({ session, sessionKey: "shutdown-all-a", brief: "a" });
      await brain.turn({ session, sessionKey: "shutdown-all-b", brief: "b" });

      shutdownPromise = brain.shutdown();
      const outcome = await shutdownPromise.then(
        () => ({ status: "fulfilled" }),
        (error) => ({ status: "rejected", error }),
      );

      expect(outcome.status).toBe("rejected");
      expect(outcome.error).toBeInstanceOf(AggregateError);
      expect(outcome.error.errors).toEqual([expect.objectContaining({ message: "first close failed" })]);
      expect(first.close).toHaveBeenCalledTimes(1);
      expect(second.close).toHaveBeenCalledTimes(1);
      expect(semaphore.release).toHaveBeenCalledTimes(2);
      expect(brain._pool.size).toBe(0);
    } finally {
      await Promise.allSettled([shutdownPromise].filter(Boolean));
      await Promise.allSettled([brain.shutdown()]);
    }
  });

  it("C0.2 P8：pre-pool close 同步抛错仍由 shutdown 聚合报告", async () => {
    const semaphore = {
      tryAcquire: vi.fn(() => true),
      release: vi.fn(),
    };
    const client = mockClient();
    client.close.mockImplementationOnce(() => { throw new Error("pre-pool close failed"); });
    const brain = createBrain({
      startPi: () => client,
      store,
      semaphore,
      sleepFn: async () => {},
      setTimeoutFn: () => 0,
      clearTimeoutFn: () => {},
      log: () => {},
    });
    let ensureOutcome;
    let shutdownPromise;

    try {
      ensureOutcome = brain._ensure("shutdown-pre-pool-close-error").then(
        (value) => ({ status: "fulfilled", value }),
        (error) => ({ status: "rejected", error }),
      );
      shutdownPromise = brain.shutdown();
      const shutdownOutcome = shutdownPromise.then(
        () => ({ status: "fulfilled" }),
        (error) => ({ status: "rejected", error }),
      );

      const [ensured, shutdown] = await Promise.all([ensureOutcome, shutdownOutcome]);
      expect(ensured.status).toBe("rejected");
      expect(ensured.error.message).toMatch(/brain.*关闭|closed|shut(?:ting)? down/i);
      expect(shutdown.status).toBe("rejected");
      expect(shutdown.error).toBeInstanceOf(AggregateError);
      expect(shutdown.error.errors).toEqual([
        expect.objectContaining({ message: "pre-pool close failed" }),
      ]);
      expect(client.close).toHaveBeenCalledTimes(1);
      expect(semaphore.release).toHaveBeenCalledTimes(1);
      expect(brain._pool.size).toBe(0);
    } finally {
      await Promise.allSettled([ensureOutcome, shutdownPromise].filter(Boolean));
      await Promise.allSettled([brain.shutdown()]);
    }
  });

  it("C0.2 P9：spawn retry sleep 中的 provisional permit 由 shutdown 单次释放", async () => {
    const retryGate = deferred();
    const semaphore = {
      tryAcquire: vi.fn(() => true),
      release: vi.fn(),
    };
    const startPi = vi.fn(() => { throw new Error("spawn failed before retry"); });
    const sleepFn = vi.fn(() => retryGate.promise);
    const brain = createBrain({
      startPi,
      store,
      semaphore,
      sleepFn,
      setTimeoutFn: () => 0,
      clearTimeoutFn: () => {},
      log: () => {},
    });
    let ensureOutcome;
    let shutdownPromise;

    try {
      ensureOutcome = brain._ensure("shutdown-provisional-permit").then(
        (value) => ({ status: "fulfilled", value }),
        (error) => ({ status: "rejected", error }),
      );
      await vi.waitFor(() => {
        expect(startPi).toHaveBeenCalledTimes(1);
        expect(sleepFn).toHaveBeenCalledTimes(1);
      });

      shutdownPromise = brain.shutdown();
      await shutdownPromise;
      expect(semaphore.release).toHaveBeenCalledTimes(1);
      expect(startPi).toHaveBeenCalledTimes(1);

      retryGate.resolve();
      const ensured = await ensureOutcome;
      expect(ensured.status).toBe("rejected");
      expect(ensured.error.message).toMatch(/brain.*关闭|closed|shut(?:ting)? down/i);
      expect(semaphore.release).toHaveBeenCalledTimes(1);
      expect(startPi).toHaveBeenCalledTimes(1);
      expect(brain._pool.size).toBe(0);
    } finally {
      retryGate.resolve();
      await Promise.allSettled([ensureOutcome, shutdownPromise].filter(Boolean));
      await Promise.allSettled([brain.shutdown()]);
    }
  });
});

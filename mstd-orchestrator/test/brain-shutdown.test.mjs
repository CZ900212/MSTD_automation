import { describe, it, expect, vi } from "vitest";
import { getEventListeners } from "node:events";
import { createBrain, defaultSleep, REASON_PROVIDERS } from "../server/models/brain.mjs";

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

describe("brain shutdown 生命周期", () => {
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

  it("C0.2 P2：shutdown 主动唤醒并等待 semaphore sleep 中的 ensure", async () => {
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
    let ensureSettled = false;
    let shutdownPromise;

    try {
      const pending = brain._ensure("shutdown-wait-key");
      ensureOutcome = pending.then(
        (value) => ({ status: "fulfilled", value }),
        (error) => ({ status: "rejected", error }),
      );
      ensureOutcome.then(() => { ensureSettled = true; });
      await vi.waitFor(() => expect(sleepFn).toHaveBeenCalledTimes(1));

      shutdownPromise = brain.shutdown();
      expect(brain.shutdown()).toBe(shutdownPromise);
      await shutdownPromise;
      expect(ensureSettled).toBe(true);
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
      await Promise.allSettled([ensureOutcome, shutdownPromise].filter(Boolean));
      await Promise.allSettled([brain.shutdown()]);
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

  it("C0.2 P9：shutdown 主动唤醒 retry sleep，等待 ensure 并单次释放 permit", async () => {
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
    let ensureSettled = false;
    let shutdownPromise;

    try {
      ensureOutcome = brain._ensure("shutdown-provisional-permit").then(
        (value) => ({ status: "fulfilled", value }),
        (error) => ({ status: "rejected", error }),
      );
      ensureOutcome.then(() => { ensureSettled = true; });
      await vi.waitFor(() => {
        expect(startPi).toHaveBeenCalledTimes(1);
        expect(sleepFn).toHaveBeenCalledTimes(1);
      });

      shutdownPromise = brain.shutdown();
      expect(brain.shutdown()).toBe(shutdownPromise);
      await shutdownPromise;
      expect(ensureSettled).toBe(true);
      expect(semaphore.release).toHaveBeenCalledTimes(1);
      expect(startPi).toHaveBeenCalledTimes(1);

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

  it("C0.2 P10：默认 retry sleep 在 shutdown 时取消定时器并完成 spawning", async () => {
    vi.useFakeTimers();
    const startPi = vi.fn(() => { throw new Error("spawn failed before default retry"); });
    const brain = createBrain({
      startPi,
      store,
      retries: 1,
      setTimeoutFn: () => 0,
      clearTimeoutFn: () => {},
      log: () => {},
    });
    let ensureOutcome;
    let ensureSettled = false;
    let shutdownPromise;

    try {
      ensureOutcome = brain._ensure("shutdown-default-retry").then(
        (value) => ({ status: "fulfilled", value }),
        (error) => ({ status: "rejected", error }),
      );
      ensureOutcome.then(() => { ensureSettled = true; });

      expect(startPi).toHaveBeenCalledTimes(1);
      expect(vi.getTimerCount()).toBe(1);

      shutdownPromise = brain.shutdown();
      expect(brain.shutdown()).toBe(shutdownPromise);
      await shutdownPromise;

      expect(ensureSettled).toBe(true);
      expect(vi.getTimerCount()).toBe(0);
      const ensured = await ensureOutcome;
      expect(ensured.status).toBe("rejected");
      expect(ensured.error.message).toMatch(/brain.*关闭|closed|shut(?:ting)? down/i);
      expect(startPi).toHaveBeenCalledTimes(1);
      expect(brain._pool.size).toBe(0);
    } finally {
      await vi.runAllTimersAsync();
      await Promise.allSettled([ensureOutcome, shutdownPromise].filter(Boolean));
      await Promise.allSettled([brain.shutdown()]);
      vi.useRealTimers();
    }
  });

  it("C0.2 P11：abort listener 同步重入 shutdown 仍复用同一 Promise", async () => {
    const semaphore = {
      tryAcquire: vi.fn(() => false),
      release: vi.fn(),
    };
    let brain;
    let reentrantShutdown;
    const sleepFn = vi.fn((_ms, signal) => new Promise(() => {
      signal.addEventListener("abort", () => {
        reentrantShutdown = brain.shutdown();
      }, { once: true });
    }));
    brain = createBrain({
      startPi: vi.fn(() => mockClient()),
      store,
      semaphore,
      sleepFn,
      setTimeoutFn: () => 0,
      clearTimeoutFn: () => {},
    });
    let ensureOutcome;
    let outerShutdown;

    try {
      ensureOutcome = brain._ensure("shutdown-abort-reentry").then(
        (value) => ({ status: "fulfilled", value }),
        (error) => ({ status: "rejected", error }),
      );
      await vi.waitFor(() => expect(sleepFn).toHaveBeenCalledTimes(1));

      outerShutdown = brain.shutdown();
      expect(reentrantShutdown).toBe(outerShutdown);
      await outerShutdown;

      const ensured = await ensureOutcome;
      expect(ensured.status).toBe("rejected");
      expect(ensured.error.message).toMatch(/brain.*关闭|closed|shut(?:ting)? down/i);
      expect(semaphore.release).not.toHaveBeenCalled();
    } finally {
      await Promise.allSettled([ensureOutcome, outerShutdown, reentrantShutdown].filter(Boolean));
      await Promise.allSettled([brain.shutdown()]);
    }
  });

  it("C0.2 P12：startPi 同步重入 shutdown 时等待当前 ensure 完成", async () => {
    const semaphore = {
      tryAcquire: vi.fn(() => true),
      release: vi.fn(),
    };
    const client = mockClient();
    let brain;
    let shutdownPromise;
    const startPi = vi.fn(() => {
      shutdownPromise = brain.shutdown();
      return client;
    });
    brain = createBrain({
      startPi,
      store,
      semaphore,
      sleepFn: async () => {},
      setTimeoutFn: () => 0,
      clearTimeoutFn: () => {},
    });
    let ensureOutcome;
    let ensureSettled = false;

    try {
      ensureOutcome = brain._ensure("shutdown-startpi-reentry").then(
        (value) => ({ status: "fulfilled", value }),
        (error) => ({ status: "rejected", error }),
      );
      ensureOutcome.then(() => { ensureSettled = true; });

      expect(shutdownPromise).toBeInstanceOf(Promise);
      await shutdownPromise;
      expect(ensureSettled).toBe(true);

      const ensured = await ensureOutcome;
      expect(ensured.status).toBe("rejected");
      expect(ensured.error.message).toMatch(/brain.*关闭|closed|shut(?:ting)? down/i);
      expect(client.close).toHaveBeenCalledTimes(1);
      expect(semaphore.release).toHaveBeenCalledTimes(1);
      expect(brain._pool.size).toBe(0);
    } finally {
      await Promise.allSettled([ensureOutcome, shutdownPromise].filter(Boolean));
      await Promise.allSettled([brain.shutdown()]);
    }
  });

  it("C0.2 P13：defaultSleep 自然到点/中止/预中止路径均不遗留 abort 监听器与定时器", async () => {
    vi.useFakeTimers();
    try {
      const natural = new AbortController();
      const p1 = defaultSleep(500, natural.signal);
      expect(getEventListeners(natural.signal, "abort")).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(500);
      await p1;
      expect(getEventListeners(natural.signal, "abort")).toHaveLength(0);
      expect(vi.getTimerCount()).toBe(0);

      const aborted = new AbortController();
      const p2 = defaultSleep(500, aborted.signal);
      expect(getEventListeners(aborted.signal, "abort")).toHaveLength(1);
      aborted.abort();
      await p2;
      expect(getEventListeners(aborted.signal, "abort")).toHaveLength(0);
      expect(vi.getTimerCount()).toBe(0);

      const pre = new AbortController();
      pre.abort();
      await defaultSleep(500, pre.signal);
      expect(getEventListeners(pre.signal, "abort")).toHaveLength(0);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("C0.2 P14：12 个会话同时等 semaphore 共享 closed signal 无监听器告警，shutdown 一次全解挂", async () => {
    vi.useFakeTimers();
    const warnings = [];
    const onWarning = (warning) => {
      if (warning?.name === "MaxListenersExceededWarning") warnings.push(warning);
    };
    process.on("warning", onWarning);
    const semaphore = {
      tryAcquire: vi.fn(() => false),
      release: vi.fn(),
    };
    const startPi = vi.fn(() => mockClient());
    const brain = createBrain({
      startPi,
      store,
      semaphore,
      setTimeoutFn: () => 0,
      clearTimeoutFn: () => {},
    });
    let outcomes;
    let shutdownPromise;

    try {
      outcomes = Array.from({ length: 12 }, (_, i) => brain._ensure(`waiter-${i}`).then(
        (value) => ({ status: "fulfilled", value }),
        (error) => ({ status: "rejected", error }),
      ));
      expect(vi.getTimerCount()).toBe(12);
      // 告警断言仅在旧运行时有意义：Node 22 的 AbortSignal 默认无监听器上限，
      // 旧版本（默认上限 10）里若 setMaxListeners 防御被移除，此处会捕获告警。
      await new Promise((resolve) => process.nextTick(resolve));
      await new Promise((resolve) => process.nextTick(resolve));
      expect(warnings).toHaveLength(0);

      shutdownPromise = brain.shutdown();
      await shutdownPromise;

      const settled = await Promise.all(outcomes);
      for (const outcome of settled) {
        expect(outcome.status).toBe("rejected");
        expect(outcome.error).toBeInstanceOf(Error);
        expect(outcome.error.message).toMatch(/brain.*关闭|closed|shut(?:ting)? down/i);
      }
      expect(vi.getTimerCount()).toBe(0);
      expect(startPi).not.toHaveBeenCalled();
      expect(semaphore.release).not.toHaveBeenCalled();
      expect(warnings).toHaveLength(0);
    } finally {
      process.off("warning", onWarning);
      await vi.runAllTimersAsync();
      await Promise.allSettled([...(outcomes ?? []), shutdownPromise].filter(Boolean));
      await Promise.allSettled([brain.shutdown()]);
      vi.useRealTimers();
    }
  });
});

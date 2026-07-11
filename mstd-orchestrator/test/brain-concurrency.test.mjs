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

describe("brain 并发与 spawn 合并", () => {
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

});

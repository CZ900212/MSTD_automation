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
  replaySet: () => ({ summary: null, messages: [{ role: "user", sender_name: "张三", content: "早", ts: 1 }] }),
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

// 20 并发目标配套:池满时 LRU 驱逐空闲 Pi 腾位,绝不动 busy 的
describe("池满 LRU 驱逐(evictIdleForSlot)", () => {
  const mkBrain = (semaphore, clients) => {
    let i = 0;
    const startPi = vi.fn(() => clients[i++] ?? mockClient());
    return {
      startPi,
      brain: createBrain({
        startPi,
        store,
        semaphore,
        // 必须让出宏任务:纯微任务 sleep 会让等位 while 循环饿死事件循环(测试 OOM)
        sleepFn: () => new Promise((r) => setImmediate(r)),
        setTimeoutFn: () => 0,
        clearTimeoutFn: () => {},
      }),
    };
  };

  it("池满且有空闲 Pi:新会话立刻驱逐最久未用者,不等 idleTimer", async () => {
    const { createSemaphore } = await import("../server/jobs/semaphore.mjs");
    const semaphore = createSemaphore(1);
    const cA = mockClient();
    const cB = mockClient();
    const { brain, startPi } = mkBrain(semaphore, [cA, cB]);
    try {
      await brain.turn({ session, sessionKey: "sess-A", brief: "回合A" }); // A 完成后空闲,占着唯一 slot
      expect(startPi).toHaveBeenCalledTimes(1);
      const done = await brain.turn({ session, sessionKey: "sess-B", brief: "回合B" });
      expect(done.finalText).toBe("done");
      expect(cA.close).toHaveBeenCalled();          // A 被驱逐回收
      expect(startPi).toHaveBeenCalledTimes(2);     // B 拿到腾出的 slot
    } finally {
      await brain.shutdown();
    }
  });

  it("busy 的 Pi 绝不被驱逐:等它回合结束才腾位", async () => {
    const { createSemaphore } = await import("../server/jobs/semaphore.mjs");
    const semaphore = createSemaphore(1);
    const gate = deferred();
    const cA = mockClient();
    cA.runJob = vi.fn(async () => { await gate.promise; return { finalText: "A-done" }; });
    const cB = mockClient();
    const { brain, startPi } = mkBrain(semaphore, [cA, cB]);
    let pA; let pB;
    try {
      pA = brain.turn({ session, sessionKey: "sess-A", brief: "长回合A" });
      await vi.waitFor(() => expect(cA.runJob).toHaveBeenCalledTimes(1));
      pB = brain.turn({ session, sessionKey: "sess-B", brief: "回合B" });
      await nextImmediate();
      await nextImmediate();
      expect(cA.close).not.toHaveBeenCalled();      // A 正忙,不许动
      expect(startPi).toHaveBeenCalledTimes(1);     // B 还在等位
      gate.resolve();
      await pA;
      expect((await pB).finalText).toBe("done");    // A 空闲后被驱逐,B 上位
      expect(cA.close).toHaveBeenCalled();
    } finally {
      gate.resolve();
      await Promise.allSettled([pA, pB].filter(Boolean));
      await brain.shutdown();
    }
  });

  it("同一会话两个 taskId 可并发进入 runJob", async () => {
    const gateA = deferred();
    const gateB = deferred();
    const entered = [];
    const cA = mockClient();
    const cB = mockClient();
    cA.runJob = vi.fn(async () => {
      entered.push("A");
      await gateA.promise;
      return { finalText: "A" };
    });
    cB.runJob = vi.fn(async () => {
      entered.push("B");
      await gateB.promise;
      return { finalText: "B" };
    });
    let n = 0;
    const startPi = vi.fn(() => (n++ === 0 ? cA : cB));
    const brain = createBrain({
      startPi,
      store,
      sleepFn: async () => {},
      setTimeoutFn: () => 0,
      clearTimeoutFn: () => {},
    });
    let pA; let pB;
    try {
      pA = brain.turn({ session, sessionKey: "same-chat", taskId: "task-a", brief: "任务A" });
      pB = brain.turn({ session, sessionKey: "same-chat", taskId: "task-b", brief: "任务B" });
      await vi.waitFor(() => expect(entered.sort()).toEqual(["A", "B"]));
      expect(startPi).toHaveBeenCalledTimes(2);
      expect(cA.runJob).toHaveBeenCalled();
      expect(cB.runJob).toHaveBeenCalled();
      gateA.resolve();
      gateB.resolve();
      const [a, b] = await Promise.all([pA, pB]);
      expect(a.finalText).toBe("A");
      expect(b.finalText).toBe("B");
    } finally {
      gateA.resolve();
      gateB.resolve();
      await Promise.allSettled([pA, pB].filter(Boolean));
      await brain.shutdown();
    }
  });

  it("同 task 仍串行，且 steer/recycle 只命中该 task", async () => {
    const firstGate = deferred();
    const order = [];
    const c = mockClient();
    c.runJob = vi.fn(async (prompt) => {
      if (prompt.includes("第一")) {
        await firstGate.promise;
        order.push("t1");
        return { finalText: "1" };
      }
      order.push("t2");
      return { finalText: "2" };
    });
    const foreign = mockClient();
    foreign.runJob = vi.fn(async () => {
      await firstGate.promise;
      return { finalText: "foreign" };
    });
    let n = 0;
    const startPi = vi.fn(() => (n++ === 0 ? c : foreign));
    const brain = createBrain({
      startPi,
      store,
      sleepFn: async () => {},
      setTimeoutFn: () => 0,
      clearTimeoutFn: () => {},
    });
    let p1; let p2; let pForeign;
    try {
      p1 = brain.turn({ session, sessionKey: "chat", taskId: "task-a", brief: "第一" });
      p2 = brain.turn({ session, sessionKey: "chat", taskId: "task-a", brief: "第二" });
      pForeign = brain.turn({ session, sessionKey: "chat", taskId: "task-b", brief: "外任务" });
      await vi.waitFor(() => expect(c.runJob).toHaveBeenCalledTimes(1));
      await vi.waitFor(() => expect(foreign.runJob).toHaveBeenCalledTimes(1));

      expect(brain.steer("chat", "插话A", { taskId: "task-a" })).toBe(true);
      expect(c.send).toHaveBeenCalledWith({ type: "prompt", message: "【用户插话】插话A" });
      expect(brain.steer("chat", "插话B", { taskId: "task-b" })).toBe(true);
      expect(foreign.send).toHaveBeenCalled();
      // Cross-task: steering A must not touch B's client with A's note alone already verified;
      // recycling A while busy is a no-op and must leave B running.
      brain.recycle("chat", { taskId: "task-a" });
      expect(c.close).not.toHaveBeenCalled();
      expect(foreign.close).not.toHaveBeenCalled();

      firstGate.resolve();
      const [r1, r2, rf] = await Promise.all([p1, p2, pForeign]);
      expect(order).toEqual(["t1", "t2"]);
      expect(r1.finalText).toBe("1");
      expect(r2.finalText).toBe("2");
      expect(rf.finalText).toBe("foreign");
    } finally {
      firstGate.resolve();
      await Promise.allSettled([p1, p2, pForeign].filter(Boolean));
      await brain.shutdown();
    }
  });

  it("task A 不能 close/recycle 掉 task B 的 resident", async () => {
    const gate = deferred();
    const cA = mockClient();
    const cB = mockClient();
    cA.runJob = vi.fn(async () => { await gate.promise; return { finalText: "A" }; });
    cB.runJob = vi.fn(async () => { await gate.promise; return { finalText: "B" }; });
    let n = 0;
    const brain = createBrain({
      startPi: vi.fn(() => (n++ === 0 ? cA : cB)),
      store,
      sleepFn: async () => {},
      setTimeoutFn: () => 0,
      clearTimeoutFn: () => {},
    });
    let pA; let pB;
    try {
      pA = brain.turn({ session, sessionKey: "chat", taskId: "task-a", brief: "A" });
      pB = brain.turn({ session, sessionKey: "chat", taskId: "task-b", brief: "B" });
      await vi.waitFor(() => expect(cA.runJob).toHaveBeenCalled());
      await vi.waitFor(() => expect(cB.runJob).toHaveBeenCalled());
      brain.recycle("chat", { taskId: "task-a" });
      expect(cB.close).not.toHaveBeenCalled();
      expect(brain.steer("chat", "x", { taskId: "task-a" })).toBe(true);
      expect(cB.send).not.toHaveBeenCalled();
      gate.resolve();
      await Promise.all([pA, pB]);
    } finally {
      gate.resolve();
      await Promise.allSettled([pA, pB].filter(Boolean));
      await brain.shutdown();
    }
  });
});

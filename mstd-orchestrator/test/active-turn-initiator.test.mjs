import { describe, it, expect } from "vitest";
import { createActiveTurnRegistry } from "../server/sessions/active-turn.mjs";

// 原 active-turn-initiator.mjs shim 已删除:选项映射(ttlMs→initiatorTtlMs)与原 shim 一致。
const createActiveTurnInitiators = ({ now, ttlMs } = {}) =>
  createActiveTurnRegistry({
    ...(now ? { now } : {}),
    ...(ttlMs != null ? { initiatorTtlMs: ttlMs } : {}),
  }).initiators;

describe("active turn initiator registry", () => {
  it("只暴露有效 active initiator，lease 防旧回合误清新回合", () => {
    let now = 100;
    const r = createActiveTurnInitiators({ now: () => now, ttlMs: 50 });
    expect(r.activate({ sessionKey: "s", initiatorOpenId: "bad" })).toBeNull();
    const oldLease = r.activate({ sessionKey: "s", initiatorOpenId: "ou_a" });
    expect(r.resolve("s")).toBe("ou_a");
    const newLease = r.activate({ sessionKey: "s", initiatorOpenId: "ou_b" });
    expect(r.clear("s", oldLease)).toBe(false);
    expect(r.resolve("s")).toBe("ou_b");
    expect(r.clear("s", newLease)).toBe(true);
    expect(r.resolve("s")).toBeNull();
  });

  it("when bound, requires exact turnId and resident epoch", () => {
    const r = createActiveTurnInitiators();
    r.activate({ sessionKey: "s", initiatorOpenId: "ou_a", turnId: "turn-1", residentEpoch: 7 });
    expect(r.resolve("s", { turnId: "turn-1", residentEpoch: 7 })).toBe("ou_a");
    expect(r.resolve("s", { turnId: "turn-2", residentEpoch: 7 })).toBeNull();
    expect(r.resolve("s", { turnId: "turn-1", residentEpoch: 8 })).toBeNull();
    expect(r.resolve("s")).toBeNull();
  });

  it("过期后 fail-closed 并清理", () => {
    let now = 100;
    const r = createActiveTurnInitiators({ now: () => now, ttlMs: 50 });
    r.activate({ sessionKey: "s", initiatorOpenId: "ou_a" });
    now = 151;
    expect(r.resolve("s")).toBeNull();
  });

  it("isolates two task initiators in one session and authorizes exact run identity", () => {
    let leaseNo = 0;
    const registry = createActiveTurnRegistry({ issueLease: () => `lease-${++leaseNo}` });
    const executionA = "task:task-a";
    const executionB = "task:task-b";
    const brainLeaseA = registry.brainTurns.activate({
      sessionKey: "chat", taskId: "task-a", runId: "run-a", executionKey: executionA,
      turnId: "turn-a", purpose: "business",
    });
    const brainLeaseB = registry.brainTurns.activate({
      sessionKey: "chat", taskId: "task-b", runId: "run-b", executionKey: executionB,
      turnId: "turn-b", purpose: "business",
    });
    registry.brainTurns.bindResident("chat", brainLeaseA, 7, {
      taskId: "task-a", runId: "run-a", executionKey: executionA,
    });
    registry.brainTurns.bindResident("chat", brainLeaseB, 8, {
      taskId: "task-b", runId: "run-b", executionKey: executionB,
    });
    const initiatorLeaseA = registry.initiators.activate({
      sessionKey: "chat", taskId: "task-a", runId: "run-a", executionKey: executionA,
      initiatorOpenId: "ou_a", turnId: "turn-a", residentEpoch: 7,
    });
    registry.initiators.activate({
      sessionKey: "chat", taskId: "task-b", runId: "run-b", executionKey: executionB,
      initiatorOpenId: "ou_b", turnId: "turn-b", residentEpoch: 8,
    });

    expect(registry.initiators.resolveAuthorized({
      sessionKey: "chat", taskId: "task-a", runId: "run-a", executionKey: executionA,
      turnId: "turn-a", lease: brainLeaseA, residentEpoch: 7,
    })).toBe("ou_a");
    expect(registry.initiators.resolveAuthorized({
      sessionKey: "chat", taskId: "task-b", runId: "run-b", executionKey: executionB,
      turnId: "turn-b", lease: brainLeaseB, residentEpoch: 8,
    })).toBe("ou_b");
    expect(registry.initiators.resolveAuthorized({
      sessionKey: "chat", taskId: "task-a", runId: "run-b", executionKey: executionA,
      turnId: "turn-a", lease: brainLeaseA, residentEpoch: 7,
    })).toBeNull();
    expect(registry.initiators.resolveAuthorized({
      sessionKey: "chat", taskId: "task-b", runId: "run-b", executionKey: executionB,
      turnId: "turn-b", lease: brainLeaseA, residentEpoch: 8,
    })).toBeNull();
    expect(registry.initiators.clear("chat", initiatorLeaseA, {
      taskId: "task-a", runId: "run-a", executionKey: executionA,
    })).toBe(true);
    expect(registry.initiators.resolve("chat", {
      taskId: "task-b", runId: "run-b", executionKey: executionB,
      turnId: "turn-b", residentEpoch: 8,
    })).toBe("ou_b");
  });

  it("revokes an initiator only through the exact live task/run identity", () => {
    const registry = createActiveTurnRegistry();
    const turnId = "turn-a";
    const brainLease = registry.brainTurns.activate({ sessionKey: "chat", taskId: "task-a", runId: "run-a", turnId, purpose: "business" });
    registry.brainTurns.bindResident("chat", brainLease, 7, { taskId: "task-a", runId: "run-a" });
    registry.initiators.activate({ sessionKey: "chat", taskId: "task-a", runId: "run-a", initiatorOpenId: "ou_a", turnId, residentEpoch: 7 });
    expect(registry.initiators.revokeAuthorized({ sessionKey: "chat", taskId: "task-a", runId: "wrong" })).toBe(false);
    expect(registry.initiators.resolve("chat", { taskId: "task-a", runId: "run-a", turnId, residentEpoch: 7 })).toBe("ou_a");
    expect(registry.initiators.revokeAuthorized({ sessionKey: "chat", taskId: "task-a", runId: "run-a" })).toBe(true);
    expect(registry.initiators.resolve("chat", { taskId: "task-a", runId: "run-a", turnId, residentEpoch: 7 })).toBeNull();
  });
});

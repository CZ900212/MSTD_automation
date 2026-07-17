import { describe, it, expect } from "vitest";
import { createSessionTokenRegistry } from "../server/http/session-tokens.mjs";

describe("C0.3 会话绑定 token 注册表", () => {
  it("issue/resolve/revoke 闭环;token 不可预测且互不相同", () => {
    const reg = createSessionTokenRegistry();
    const t1 = reg.issue("feishu:p2p:ou_a");
    const t2 = reg.issue("feishu:group:oc_b");
    expect(t1).not.toBe(t2);
    expect(typeof t1).toBe("string");
    expect(t1.length).toBeGreaterThanOrEqual(16);
    expect(reg.resolve(t1)).toBe("feishu:p2p:ou_a");
    expect(reg.resolve("不存在")).toBeNull();
    reg.revoke(t1);
    expect(reg.resolve(t1)).toBeNull();
    expect(reg.resolve(t2)).toBe("feishu:group:oc_b");
  });

  it("同一会话可同时持有多个 token(降级新旧 Pi 交接期);revoke 只吊销指定 token", () => {
    const reg = createSessionTokenRegistry();
    const t1 = reg.issue("k1");
    const t2 = reg.issue("k1");
    expect(t1).not.toBe(t2);
    reg.revoke(t1);
    expect(reg.resolve(t1)).toBeNull();
    expect(reg.resolve(t2)).toBe("k1");
  });

  it("revoke 容忍 null/undefined/未知 token,不抛错", () => {
    const reg = createSessionTokenRegistry();
    expect(() => reg.revoke(null)).not.toThrow();
    expect(() => reg.revoke(undefined)).not.toThrow();
    expect(() => reg.revoke("从未签发")).not.toThrow();
  });

  it("keeps spawn identity immutable while binding and clearing the current run attempt", () => {
    const reg = createSessionTokenRegistry();
    const token = reg.issue("chat", {
      taskId: "task-a",
      residentKey: "task:task-a",
      residentEpoch: 7,
    });

    expect(reg.bindTurn(token, {
      taskId: "task-a",
      runId: "run-1",
      dispatchId: "dispatch-1",
      turnId: "turn-1",
      lease: "lease-1",
      executionKey: "task:task-a",
    })).toBe(true);
    expect(reg.resolveBinding(token)).toEqual({
      sessionKey: "chat",
      taskId: "task-a",
      residentKey: "task:task-a",
      residentEpoch: 7,
      runId: "run-1",
      dispatchId: "dispatch-1",
      turnId: "turn-1",
      turnLease: "lease-1",
      executionKey: "task:task-a",
    });
    expect(Object.isFrozen(reg.resolveBinding(token))).toBe(true);

    expect(reg.clearTurn(token, { runId: "run-old", turnId: "turn-1", lease: "lease-1" })).toBe(false);
    expect(reg.resolveBinding(token)).toMatchObject({ runId: "run-1", turnLease: "lease-1" });
    expect(reg.clearTurn(token, { runId: "run-1", turnId: "turn-1", lease: "lease-1" })).toBe(true);
    expect(reg.resolveBinding(token)).toEqual({
      sessionKey: "chat",
      taskId: "task-a",
      residentKey: "task:task-a",
      residentEpoch: 7,
    });
  });

  it("refuses a turn binding that crosses the spawn task or execution key", () => {
    const reg = createSessionTokenRegistry();
    const token = reg.issue("chat", { taskId: "task-a", residentKey: "task:task-a" });

    expect(reg.bindTurn(token, {
      taskId: "task-b",
      runId: "run-b",
      turnId: "turn-b",
      lease: "lease-b",
      executionKey: "task:task-b",
    })).toBe(false);
    expect(reg.bindTurn(token, {
      taskId: "task-a",
      runId: "run-a",
      turnId: "turn-a",
      lease: "lease-a",
      executionKey: "task:other",
    })).toBe(false);
    expect(reg.resolveBinding(token)).not.toHaveProperty("runId");
  });

  it("stale cleanup from a prior run cannot clear a newer run binding", () => {
    const reg = createSessionTokenRegistry();
    const token = reg.issue("chat", { taskId: "task-a", residentKey: "task:task-a" });
    const first = {
      taskId: "task-a", runId: "run-1", turnId: "turn-1", lease: "lease-1", executionKey: "task:task-a",
    };
    const second = {
      taskId: "task-a", runId: "run-2", turnId: "turn-2", lease: "lease-2", executionKey: "task:task-a",
    };
    expect(reg.bindTurn(token, first)).toBe(true);
    expect(reg.bindTurn(token, second)).toBe(true);
    expect(reg.clearTurn(token, first)).toBe(false);
    expect(reg.resolveBinding(token)).toMatchObject({ runId: "run-2", turnId: "turn-2", turnLease: "lease-2" });
  });
});

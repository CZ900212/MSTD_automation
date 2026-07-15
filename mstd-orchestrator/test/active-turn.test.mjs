import { describe, expect, it } from "vitest";
import { createActiveTurnRegistry } from "../server/sessions/active-turn.mjs";

describe("统一回合注册表（单条 per-session 记录 + 单一回合 lease）", () => {
  it("business 回合：receipt 与 brain 共享同一把回合 lease，admit 直接可用", () => {
    const reg = createActiveTurnRegistry({ issueId: () => "turn-1" });
    const receipt = reg.receipts.begin({ sessionKey: "s", purpose: "business", expectsReply: true });
    const lease = reg.brainTurns.activate({ sessionKey: "s", turnId: receipt.turnId, purpose: "business" });
    expect(lease).toBeTruthy();
    expect(reg.brainTurns.bindResident("s", lease, 7)).toBe(true);
    const admission = reg.brainTurns.admit({ sessionKey: "s", turnId: "turn-1", lease, residentEpoch: 7 });
    expect(admission.ok).toBe(true);
    // snapshot 不再暴露 lease（凭据只在签发方与持有方之间流转）
    expect(reg.brainTurns.resolve("s")).toMatchObject({ turnId: "turn-1", state: "active" });
    expect(reg.brainTurns.resolve("s").lease).toBeUndefined();
  });

  it("formal delivery 原子提交 brain receipt 与同回合 business 终态", () => {
    const reg = createActiveTurnRegistry({ issueId: () => "turn-1" });
    const receipt = reg.receipts.begin({ sessionKey: "s", purpose: "business", expectsReply: true });
    const lease = reg.brainTurns.activate({ sessionKey: "s", turnId: receipt.turnId, purpose: "business" });
    reg.brainTurns.bindResident("s", lease, 7);
    const admission = reg.brainTurns.admit({
      sessionKey: "s",
      turnId: receipt.turnId,
      lease,
      residentEpoch: 7,
    });
    expect(reg.brainTurns.reserveDelivery(admission, {
      stage: "final",
      source: "rendered_reply",
    })).toBe(true);

    const recorded = reg.brainTurns.recordDelivery(admission, {
      stage: "final",
      source: "rendered_reply",
      messageId: "om_final",
    });

    expect(recorded).toMatchObject({
      ok: true,
      receipt: {
        state: "terminal",
        terminal: { outcome: "formal_reply_sent", messageId: "om_final" },
      },
    });
    expect(reg.receipts.resolve("s")).toMatchObject({
      state: "terminal",
      terminal: { outcome: "formal_reply_sent", messageId: "om_final" },
    });
  });

  it("与活跃 receipt 的 turnId 不一致的 brain activate 直接拒绝（fail-loud，不顶掉回合 lease）", () => {
    const reg = createActiveTurnRegistry({ issueId: () => "turn-1" });
    reg.receipts.begin({ sessionKey: "s", purpose: "business", expectsReply: true });
    expect(reg.brainTurns.activate({ sessionKey: "s", turnId: "别的回合", purpose: "automation" })).toBeNull();
  });

  it("活跃 brain 回合占用会话时 receipts.begin 抛错，不签发第二个身份", () => {
    const reg = createActiveTurnRegistry();
    const lease = reg.brainTurns.activate({ sessionKey: "s", turnId: "t-auto", purpose: "automation" });
    expect(lease).toBeTruthy();
    expect(() => reg.receipts.begin({ sessionKey: "s" })).toThrow(/active turn/);
  });

  it("任一域清空即整条记录回收：inspect 归零，下一回合拿到全新 lease", async () => {
    const reg = createActiveTurnRegistry({ issueId: () => "turn-1" });
    const receipt = reg.receipts.begin({ sessionKey: "s", purpose: "business", expectsReply: true });
    const lease1 = reg.brainTurns.activate({ sessionKey: "s", turnId: receipt.turnId, purpose: "business" });
    await reg.brainTurns.closeAdmissions("s", lease1, { provider: "p" });
    expect(reg.brainTurns.finalizeTurn("s", lease1)).toMatchObject({ state: "closed" });
    expect(reg.receipts.clear(receipt)).toBe(true);
    expect(reg.inspect("s")).toBeNull();
    const lease2 = reg.brainTurns.activate({ sessionKey: "s", turnId: "t-next", purpose: "automation" });
    expect(lease2).toBeTruthy();
    expect(lease2).not.toBe(lease1);
  });

  it("回合轮换清掉上一回合的 initiator 授权，不跨回合存活", () => {
    let clock = 1_000;
    const reg = createActiveTurnRegistry({ now: () => clock, issueId: () => `turn-${clock}` });
    const r1 = reg.receipts.begin({ sessionKey: "s" });
    reg.initiators.activate({ sessionKey: "s", initiatorOpenId: "ou_alice", turnId: null, residentEpoch: null });
    expect(reg.initiators.resolve("s")).toBe("ou_alice");
    expect(reg.receipts.clear(r1)).toBe(true);       // initiator 域还在 → 记录未回收
    clock += 1;
    const r2 = reg.receipts.begin({ sessionKey: "s" });  // 轮换新回合
    expect(reg.initiators.resolve("s")).toBeNull();      // 旧授权已随轮换清除
    expect(r2.turnId).not.toBe(r1.turnId);
  });

  it("initiator 保留 attempt 级租约：新尝试顶替后旧租约清不掉新授权", () => {
    const reg = createActiveTurnRegistry();
    const a1 = reg.initiators.activate({ sessionKey: "s", initiatorOpenId: "ou_a" });
    const a2 = reg.initiators.activate({ sessionKey: "s", initiatorOpenId: "ou_b" });
    expect(a1).not.toBe(a2);
    expect(reg.initiators.clear("s", a1)).toBe(false);
    expect(reg.initiators.resolve("s")).toBe("ou_b");
    expect(reg.initiators.clear("s", a2)).toBe(true);
    expect(reg.inspect("s")).toBeNull();
  });

  it("resolveAuthorized 原子校验 active brain identity 后才返回真实发起人", () => {
    const reg = createActiveTurnRegistry({ issueLease: () => "lease-1" });
    const lease = reg.brainTurns.activate({ sessionKey: "s", turnId: "turn-1", purpose: "business" });
    reg.brainTurns.bindResident("s", lease, 7);
    reg.initiators.activate({
      sessionKey: "s",
      initiatorOpenId: "ou_a",
      turnId: "turn-1",
      residentEpoch: 7,
    });

    expect(reg.initiators.resolveAuthorized({
      sessionKey: "s",
      turnId: "turn-1",
      lease: "lease-1",
      residentEpoch: 7,
    })).toBe("ou_a");
    expect(reg.initiators.resolveAuthorized({
      sessionKey: "s",
      turnId: "turn-1",
      lease: "wrong",
      residentEpoch: 7,
    })).toBeNull();
    expect(reg.initiators.resolveAuthorized({
      sessionKey: "s",
      turnId: "turn-1",
      lease: "lease-1",
      residentEpoch: 8,
    })).toBeNull();
  });

  it("同一 sessionKey 下两个 task 执行记录可并存", () => {
    let n = 0;
    const reg = createActiveTurnRegistry({ issueLease: () => `lease-${++n}` });
    const a = reg.brainTurns.activate({
      sessionKey: "chat",
      taskId: "task-a",
      runId: "run-a",
      turnId: "turn-a",
      purpose: "business",
    });
    const b = reg.brainTurns.activate({
      sessionKey: "chat",
      taskId: "task-b",
      runId: "run-b",
      turnId: "turn-b",
      purpose: "business",
    });
    expect(a).toBeTruthy();
    expect(b).toBeTruthy();
    expect(a).not.toBe(b);
    expect(reg.brainTurns.bindResident("chat", a, 1, { taskId: "task-a", runId: "run-a" })).toBe(true);
    expect(reg.brainTurns.bindResident("chat", b, 2, { taskId: "task-b", runId: "run-b" })).toBe(true);
    expect(reg.brainTurns.resolve("chat", { taskId: "task-a", runId: "run-a" })).toMatchObject({
      turnId: "turn-a",
      taskId: "task-a",
      residentEpoch: 1,
    });
    expect(reg.brainTurns.resolve("chat", { taskId: "task-b", runId: "run-b" })).toMatchObject({
      turnId: "turn-b",
      taskId: "task-b",
      residentEpoch: 2,
    });
    // Closing A must not drop B.
    expect(reg.brainTurns.clear("chat", a, { taskId: "task-a", runId: "run-a" })).toBe(true);
    expect(reg.brainTurns.resolve("chat", { taskId: "task-b", runId: "run-b" })).toMatchObject({ turnId: "turn-b" });
  });
});

import { describe, expect, it, vi } from "vitest";
import { createActiveTurnRegistry } from "../server/sessions/active-turn.mjs";

// 原 active-brain-turn.mjs shim 已删除:本文件测 brain 域行为,用统一注册表取域,
// 选项映射(ttlMs→brainTtlMs)与原 shim 一致。
const createActiveBrainTurns = ({ now, ttlMs, issueLease, drainTimeoutMs, setTimeoutFn, clearTimeoutFn } = {}) =>
  createActiveTurnRegistry({
    ...(now ? { now } : {}),
    ...(issueLease ? { issueLease } : {}),
    ...(ttlMs != null ? { brainTtlMs: ttlMs } : {}),
    ...(drainTimeoutMs != null ? { drainTimeoutMs } : {}),
    ...(setTimeoutFn ? { setTimeoutFn } : {}),
    ...(clearTimeoutFn ? { clearTimeoutFn } : {}),
  }).brainTurns;

describe("active brain turn registry", () => {
  it("binds daemon turn identity and purpose with a lease", () => {
    let now = 100;
    const active = createActiveBrainTurns({ now: () => now, ttlMs: 50, issueLease: () => "lease-1" });
    const lease = active.activate({ sessionKey: "s", turnId: "turn-1", purpose: "business" });
    expect(lease).toBe("lease-1");
    expect(active.bindResident("s", lease, 7)).toBe(true);
    expect(active.resolve("s")).toMatchObject({ turnId: "turn-1", purpose: "business", residentEpoch: 7 });
    now = 151;
    expect(active.resolve("s")).toBeNull();
  });

  it("rejects a replacement until the current execution is finalized, then old cleanup cannot clear it", async () => {
    let lease = 0;
    const active = createActiveBrainTurns({ issueLease: () => `lease-${++lease}` });
    const one = active.activate({ sessionKey: "s", turnId: "turn-1", purpose: "business" });
    expect(active.activate({ sessionKey: "s", turnId: "turn-2", purpose: "memory_maintenance" })).toBeNull();
    expect(active.bindResident("s", one, 1)).toBe(true);
    await active.closeAdmissions("s", one);
    expect(active.finalizeTurn("s", one)).toMatchObject({ turnId: "turn-1", state: "closed" });

    const two = active.activate({ sessionKey: "s", turnId: "turn-2", purpose: "memory_maintenance" });
    expect(active.bindResident("s", two, 2)).toBe(true);
    expect(active.clear("s", one)).toBe(false);
    expect(active.resolve("s")).toMatchObject({ turnId: "turn-2", purpose: "memory_maintenance", residentEpoch: 2 });
    expect(active.clear("s", two)).toBe(true);
  });

  it("closes admissions, drains an in-flight final send, then freezes its receipt only on finalize", async () => {
    let drained;
    const active = createActiveBrainTurns({ issueLease: () => "lease-1" });
    const lease = active.activate({ sessionKey: "s", turnId: "turn-1", purpose: "business" });
    expect(active.bindResident("s", lease, 7)).toBe(true);

    const admission = active.admit({
      sessionKey: "s",
      turnId: "turn-1",
      lease,
      residentEpoch: 7,
    });
    expect(admission).toMatchObject({ ok: true });
    expect(active.reserveDelivery(admission, {
      stage: "final",
      source: "rendered_reply",
    })).toBe(true);
    expect(active.resolve("s")).toMatchObject({ state: "active", inFlight: 1 });

    const closing = active.closeAdmissions("s", lease, { provider: "gpt-5.6-sol" })
      .then((snapshot) => { drained = snapshot; return snapshot; });
    await Promise.resolve();
    expect(active.resolve("s")).toMatchObject({ state: "closing", inFlight: 1 });
    expect(active.admit({ sessionKey: "s", turnId: "turn-1", lease, residentEpoch: 7 }))
      .toMatchObject({ ok: false, code: "turn_closing" });
    expect(drained).toBeUndefined();

    expect(active.recordDelivery(admission, {
      stage: "final",
      source: "rendered_reply",
      messageId: "om_final",
    })).toEqual({ ok: true, receipt: null });
    expect(active.release(admission)).toBe(true);
    const closingSnapshot = await closing;
    expect(closingSnapshot).toMatchObject({
      state: "closing",
      finalReceipt: expect.objectContaining({ stage: "final", source: "rendered_reply", messageId: "om_final" }),
      replyCounts: { progress: 0, final: 1, safeFallback: 0, daemonFallback: 0 },
    });
    expect(active.resolve("s")).toMatchObject({ state: "closing", inFlight: 0 });

    const outcome = active.finalizeTurn("s", lease);
    expect(outcome).toEqual(expect.objectContaining({
      turnId: "turn-1",
      purpose: "business",
      state: "closed",
      provider: "gpt-5.6-sol",
      finalReceipt: expect.objectContaining({ stage: "final", source: "rendered_reply", messageId: "om_final" }),
      replyCounts: { progress: 0, final: 1, safeFallback: 0, daemonFallback: 0 },
    }));
    expect(Object.isFrozen(outcome)).toBe(true);
    expect(Object.isFrozen(outcome.replyCounts)).toBe(true);
    expect(active.resolve("s")).toBeNull();
  });

  it("records a daemon fallback after resident admissions drain and before final outcome freezes", async () => {
    const active = createActiveBrainTurns({ issueLease: () => "lease-1" });
    const lease = active.activate({ sessionKey: "s", turnId: "turn-1", purpose: "business" });
    active.bindResident("s", lease, 7);

    await active.closeAdmissions("s", lease, { provider: "gpt-5.6-sol" });
    expect(active.recordDaemonDelivery({
      sessionKey: "s",
      turnId: "turn-1",
      lease,
    }, { messageId: "om_fallback" })).toEqual({ ok: true, receipt: null });

    expect(active.finalizeTurn("s", lease)).toMatchObject({
      state: "closed",
      finalReceipt: {
        stage: "final",
        source: "daemon_terminal_fallback",
        messageId: "om_fallback",
      },
      replyCounts: { progress: 0, final: 0, safeFallback: 0, daemonFallback: 1 },
    });
  });

  it("drain deadline aborts a hung admission and resolves after its handler releases", async () => {
    vi.useFakeTimers();
    try {
      const active = createActiveBrainTurns({ issueLease: () => "lease-1", drainTimeoutMs: 25 });
      const lease = active.activate({ sessionKey: "s", turnId: "turn-1", purpose: "business" });
      active.bindResident("s", lease, 7);
      const admission = active.admit({ sessionKey: "s", turnId: "turn-1", lease, residentEpoch: 7 });
      const signal = active.admissionSignal(admission);
      const closing = active.closeAdmissions("s", lease, { provider: "gpt-5.6-sol" });

      expect(signal.aborted).toBe(false);
      await vi.advanceTimersByTimeAsync(25);
      expect(signal.aborted).toBe(true);
      expect(active.resolve("s")).toMatchObject({ state: "closing", inFlight: 1, drainTimedOut: true });

      expect(active.release(admission)).toBe(true);
      await expect(closing).resolves.toMatchObject({
        state: "closing",
        inFlight: 0,
        drainTimedOut: true,
      });
      expect(active.finalizeTurn("s", lease)).toMatchObject({ state: "closed", drainTimedOut: true });
    } finally {
      vi.useRealTimers();
    }
  });

  it("reserves at most one concurrent final physical send and releases an uncommitted reservation", () => {
    const active = createActiveBrainTurns({ issueLease: () => "lease-1" });
    const lease = active.activate({ sessionKey: "s", turnId: "turn-1", purpose: "business" });
    active.bindResident("s", lease, 7);
    const one = active.admit({ sessionKey: "s", turnId: "turn-1", lease, residentEpoch: 7 });
    const two = active.admit({ sessionKey: "s", turnId: "turn-1", lease, residentEpoch: 7 });

    expect(active.reserveDelivery(one, { stage: "final", source: "rendered_reply" })).toBe(true);
    expect(active.reserveDelivery(two, { stage: "final", source: "rendered_reply" })).toBe(false);
    expect(active.release(one)).toBe(true);
    expect(active.reserveDelivery(two, { stage: "final", source: "rendered_reply" })).toBe(true);
    expect(active.recordDelivery(two, {
      stage: "final",
      source: "rendered_reply",
      messageId: "om_two",
    })).toEqual({ ok: true, receipt: null });
    expect(active.release(two)).toBe(true);
  });

  it("rejects stale lease/epoch/id and records only successful admitted deliveries", () => {
    const active = createActiveBrainTurns({ issueLease: () => "lease-1" });
    const lease = active.activate({ sessionKey: "s", turnId: "turn-1", purpose: "business" });
    active.bindResident("s", lease, 7);
    const variants = [
      { sessionKey: "s", turnId: "wrong", lease, residentEpoch: 7 },
      { sessionKey: "s", turnId: "turn-1", lease: "wrong", residentEpoch: 7 },
      { sessionKey: "s", turnId: "turn-1", lease, residentEpoch: 8 },
    ];
    for (const identity of variants) {
      expect(active.admit(identity)).toMatchObject({ ok: false, code: "stale_turn_context" });
    }
    const admission = active.admit({ sessionKey: "s", turnId: "turn-1", lease, residentEpoch: 7 });
    expect(active.reserveDelivery(admission, { stage: "final", source: "rendered_reply" })).toBe(true);
    expect(active.recordDelivery(admission, {
      stage: "final",
      source: "rendered_reply",
      messageId: "om_1",
    })).toEqual({ ok: true, receipt: null });
    expect(active.recordDelivery(admission, {
      stage: "final",
      source: "rendered_reply",
      messageId: "om_2",
    })).toEqual({ ok: false, receipt: null });
    expect(active.release(admission)).toBe(true);
  });

  it("old finish cannot close or clear a replacement turn", async () => {
    let leaseNo = 0;
    const active = createActiveBrainTurns({ issueLease: () => `lease-${++leaseNo}` });
    const oldLease = active.activate({ sessionKey: "s", turnId: "turn-1", purpose: "business" });
    await active.closeAdmissions("s", oldLease);
    active.finalizeTurn("s", oldLease);
    const newLease = active.activate({ sessionKey: "s", turnId: "turn-2", purpose: "automation" });
    expect(await active.closeAdmissions("s", oldLease)).toBeNull();
    expect(active.finalizeTurn("s", oldLease)).toBeNull();
    expect(newLease).toBeTruthy();
    expect(active.resolve("s")).toMatchObject({ turnId: "turn-2", state: "active" });
  });

  it("requires exact task/run identity for task-scoped admissions and exposes run snapshots", () => {
    const active = createActiveBrainTurns({ issueLease: () => "lease-1" });
    const identity = {
      sessionKey: "s", taskId: "task-a", runId: "run-a", executionKey: "task:task-a",
    };
    const lease = active.activate({ ...identity, turnId: "turn-a", purpose: "business" });
    expect(active.bindResident("s", lease, 7, identity)).toBe(true);
    expect(active.resolve("s", identity)).toMatchObject({ taskId: "task-a", runId: "run-a" });

    expect(active.admit({
      ...identity, turnId: "turn-a", lease, residentEpoch: 7,
    })).toMatchObject({ ok: true, taskId: "task-a", runId: "run-a", executionKey: "task:task-a" });
    expect(active.admit({
      ...identity, runId: "run-old", turnId: "turn-a", lease, residentEpoch: 7,
    })).toMatchObject({ ok: false, code: "stale_turn_context" });
    expect(active.admit({
      ...identity, taskId: "task-b", turnId: "turn-a", lease, residentEpoch: 7,
    })).toMatchObject({ ok: false, code: "stale_turn_context" });
  });

  it("rotates run metadata when one task resident starts its next run", async () => {
    let n = 0;
    const active = createActiveBrainTurns({ issueLease: () => `lease-${++n}` });
    const base = { sessionKey: "s", taskId: "task-a", executionKey: "task:task-a" };
    const first = active.activate({ ...base, runId: "run-1", turnId: "turn-1", purpose: "business" });
    expect(active.bindResident("s", first, 1, { ...base, runId: "run-1" })).toBe(true);
    await active.closeAdmissions("s", first, { ...base, runId: "run-1" });
    expect(active.finalizeTurn("s", first, { ...base, runId: "run-1" })).toMatchObject({ runId: "run-1" });

    const second = active.activate({ ...base, runId: "run-2", turnId: "turn-2", purpose: "business" });
    expect(second).not.toBe(first);
    expect(active.bindResident("s", second, 2, { ...base, runId: "run-2" })).toBe(true);
    expect(active.resolve("s", { ...base, runId: "run-2" })).toMatchObject({
      taskId: "task-a", runId: "run-2", turnId: "turn-2", residentEpoch: 2,
    });
    expect(active.resolve("s", { ...base, runId: "run-1" })).toBeNull();
  });

  it("rejects malformed identity or unsupported purpose", () => {
    const active = createActiveBrainTurns();
    expect(active.activate({ sessionKey: "", turnId: "t", purpose: "business" })).toBeNull();
    expect(active.activate({ sessionKey: "s", turnId: "", purpose: "business" })).toBeNull();
    expect(active.activate({ sessionKey: "s", turnId: "t", purpose: "unknown" })).toBeNull();
    expect(active.activate({ sessionKey: "s", taskId: "task-a", turnId: "t", purpose: "business" })).toBeNull();
  });
});

import { describe, it, expect, beforeEach, vi } from "vitest";
import { openDb, migrate } from "../server/db/index.mjs";
import { createSessionStore } from "../server/sessions/store.mjs";
import { createReasoningTaskStore } from "../server/reasoning/task-store.mjs";
import { createReasoningCoordinator } from "../server/reasoning/coordinator.mjs";

describe("reasoning coordinator", () => {
  let db, sessions, taskStore, session, brain, events;

  beforeEach(() => {
    db = openDb();
    migrate(db);
    sessions = createSessionStore(db);
    taskStore = createReasoningTaskStore(db);
    session = sessions.getOrCreate("feishu:p2p:ou_a", { kind: "p2p" });
    events = [];
    brain = {
      turn: vi.fn(async () => ({ finalText: "done" })),
      steer: vi.fn(() => true),
      isBusy: vi.fn(() => false),
    };
  });

  function makeCoordinator(extra = {}) {
    return createReasoningCoordinator({
      taskStore,
      brain,
      store: sessions,
      onEvent: (e) => events.push(e),
      maxReasonersPerSession: 3,
      ...extra,
    });
  }

  it("no_reasoning creates neither task nor Pi turn", async () => {
    const c = makeCoordinator();
    const out = await c.applyDecision({
      session,
      sessionKey: "feishu:p2p:ou_a",
      decision: { action: "no_reasoning", reason_code: "complete_answer" },
      sourceMessageIds: [],
    });
    expect(out.action).toBe("no_reasoning");
    expect(brain.turn).not.toHaveBeenCalled();
    expect(taskStore.activeSummaries(session.id)).toHaveLength(0);
  });

  it("spawn_new creates a server task, links sources, and starts one reasoner", async () => {
    const c = makeCoordinator();
    const m = sessions.append(session.id, { role: "user", content: "查会议室", ts: 1 });
    const out = await c.applyDecision({
      session,
      sessionKey: "feishu:p2p:ou_a",
      decision: {
        action: "spawn_new",
        title: "查会议室",
        brief: "查周五空档",
        closure: "silent_ok",
        reason_code: "needs_tools",
      },
      sourceMessageIds: [m.id],
    });
    expect(out.action).toBe("spawn_new");
    expect(out.taskId).toBeTruthy();
    await vi.waitFor(() => expect(brain.turn).toHaveBeenCalledTimes(1));
    expect(brain.turn.mock.calls[0][0]).toMatchObject({
      sessionKey: "feishu:p2p:ou_a",
      taskId: out.taskId,
      brief: "查周五空档",
    });
    expect(taskStore.listMessages(out.taskId).map((x) => x.id)).toContain(m.id);
    expect(events.some((e) => e.type === "task_created")).toBe(true);
  });

  it("attach_existing links input and steers a busy task", async () => {
    const task = taskStore.createTask({ sessionId: session.id, title: "改会议" });
    brain.isBusy = vi.fn(({ taskId }) => taskId === task.id);
    const c = makeCoordinator();
    const m = sessions.append(session.id, { role: "user", content: "改成周五", ts: 1 });
    const out = await c.applyDecision({
      session,
      sessionKey: "feishu:p2p:ou_a",
      decision: {
        action: "attach_existing",
        task_id: task.id,
        brief: "用户改周五",
        closure: "required",
        reason_code: "same_task_update",
      },
      sourceMessageIds: [m.id],
    });
    expect(out).toMatchObject({ action: "attach_existing", steered: true });
    expect(brain.steer).toHaveBeenCalledWith("feishu:p2p:ou_a", "用户改周五", { taskId: task.id });
    expect(brain.turn).not.toHaveBeenCalled();
  });

  it("idle existing task starts a new run without creating another task", async () => {
    const task = taskStore.createTask({ sessionId: session.id, title: "改会议" });
    brain.isBusy = vi.fn(() => false);
    const c = makeCoordinator();
    const before = taskStore.activeSummaries(session.id).length;
    const out = await c.applyDecision({
      session,
      sessionKey: "feishu:p2p:ou_a",
      decision: {
        action: "attach_existing",
        task_id: task.id,
        brief: "继续",
        closure: "required",
        reason_code: "same_task_update",
      },
      sourceMessageIds: [],
    });
    expect(out.started).toBe(true);
    await vi.waitFor(() => expect(brain.turn).toHaveBeenCalledTimes(1));
    expect(taskStore.activeSummaries(session.id)).toHaveLength(before);
  });

  it("two unrelated tasks can run concurrently in one session", async () => {
    const gates = [Promise.withResolvers(), Promise.withResolvers()];
    let n = 0;
    brain.turn = vi.fn(async () => {
      const i = n++;
      await gates[i].promise;
      return { finalText: String(i) };
    });
    const c = makeCoordinator();
    await c.applyDecision({
      session, sessionKey: "feishu:p2p:ou_a",
      decision: { action: "spawn_new", title: "A", brief: "A", closure: "silent_ok", reason_code: "x" },
    });
    await c.applyDecision({
      session, sessionKey: "feishu:p2p:ou_a",
      decision: { action: "spawn_new", title: "B", brief: "B", closure: "silent_ok", reason_code: "x" },
    });
    await vi.waitFor(() => expect(brain.turn).toHaveBeenCalledTimes(2));
    expect(brain.turn.mock.calls[0][0].taskId).not.toBe(brain.turn.mock.calls[1][0].taskId);
    gates[0].resolve();
    gates[1].resolve();
  });

  it("refuses fabricated or cross-session task ids", async () => {
    const other = sessions.getOrCreate("feishu:p2p:ou_b", { kind: "p2p" });
    const foreign = taskStore.createTask({ sessionId: other.id, title: "外会话" });
    const c = makeCoordinator();
    await expect(c.applyDecision({
      session,
      sessionKey: "feishu:p2p:ou_a",
      decision: {
        action: "attach_existing",
        task_id: foreign.id,
        brief: "x",
        closure: "required",
        reason_code: "same_task_update",
      },
    })).rejects.toThrow(/跨会话|不存在/);
    await expect(c.applyDecision({
      session,
      sessionKey: "feishu:p2p:ou_a",
      decision: {
        action: "attach_existing",
        task_id: "missing-id",
        brief: "x",
        closure: "required",
        reason_code: "same_task_update",
      },
    })).rejects.toThrow();
    expect(brain.turn).not.toHaveBeenCalled();
  });
});

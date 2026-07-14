import { describe, it, expect, beforeEach, vi } from "vitest";
import { openDb, migrate } from "../server/db/index.mjs";
import { createSessionStore } from "../server/sessions/store.mjs";
import { createReasoningTaskStore } from "../server/reasoning/task-store.mjs";
import { createReasoningCoordinator } from "../server/reasoning/coordinator.mjs";
import { createActiveTurnRegistry } from "../server/sessions/active-turn.mjs";
import { createReplyPipeline } from "../server/gateway/reply-pipeline.mjs";
import { createReplyProvenanceRegistry } from "../server/safety/reply-egress.mjs";

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
    expect(taskStore.getTask(task.id).closure_mode).toBe("required");
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
    await vi.waitFor(() => expect(taskStore.getTask(task.id).status).toBe("completed"));
    expect(db.prepare("SELECT COUNT(*) AS n FROM reasoning_tasks WHERE session_id = ?").get(session.id).n).toBe(before);
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

  it("required task without a final reply sends one daemon closure and completes the task", async () => {
    const activeBrainTurns = createActiveTurnRegistry().brainTurns;
    const outbound = {
      sendMessage: vi.fn(async () => ({ messageId: "om_required" })),
      sendCard: vi.fn(async () => ({ messageId: "om_required_card" })),
    };
    const pipeline = createReplyPipeline({
      outbound,
      store: sessions,
      budget: { record: vi.fn() },
      renderReply: vi.fn(),
      activeBrainTurns,
    });
    brain.turn = vi.fn(async ({ sessionKey, taskId }) => {
      const executionKey = `task:${taskId}`;
      const turnId = `turn:${taskId}`;
      const lease = activeBrainTurns.activate({ sessionKey, taskId, executionKey, turnId, purpose: "business" });
      activeBrainTurns.bindResident(sessionKey, lease, 1, { taskId, executionKey });
      const closing = await activeBrainTurns.closeAdmissions(sessionKey, lease, { taskId, executionKey });
      return { turnLifecycle: { sessionKey, taskId, turnId, lease, closing } };
    });
    const c = makeCoordinator({ activeBrainTurns, deliverTerminal: pipeline.deliverTerminal });

    const out = await c.applyDecision({
      session,
      sessionKey: "feishu:p2p:ou_a",
      decision: { action: "spawn_new", title: "必须闭合", brief: "处理", closure: "required", reason_code: "promise" },
    });

    await vi.waitFor(() => expect(taskStore.getTask(out.taskId).status).toBe("completed"));
    expect(outbound.sendMessage).toHaveBeenCalledTimes(1);
    expect(outbound.sendMessage).toHaveBeenCalledWith(expect.objectContaining({
      text: expect.stringContaining("没能生成"),
    }));
    expect(activeBrainTurns.resolve("feishu:p2p:ou_a", { taskId: out.taskId, executionKey: `task:${out.taskId}` })).toBeNull();
  });

  it("a required follow-up attached during a running silent task upgrades its terminal closure", async () => {
    const gate = Promise.withResolvers();
    const activeBrainTurns = createActiveTurnRegistry().brainTurns;
    const outbound = {
      sendMessage: vi.fn(async () => ({ messageId: "om_upgraded" })),
      sendCard: vi.fn(async () => ({ messageId: "om_upgraded_card" })),
    };
    const pipeline = createReplyPipeline({
      outbound,
      store: sessions,
      budget: { record: vi.fn() },
      renderReply: vi.fn(),
      activeBrainTurns,
    });
    brain.turn = vi.fn(async ({ sessionKey, taskId }) => {
      await gate.promise;
      const executionKey = `task:${taskId}`;
      const turnId = `turn:${taskId}`;
      const lease = activeBrainTurns.activate({ sessionKey, taskId, executionKey, turnId, purpose: "business" });
      activeBrainTurns.bindResident(sessionKey, lease, 1, { taskId, executionKey });
      const closing = await activeBrainTurns.closeAdmissions(sessionKey, lease, { taskId, executionKey });
      return { turnLifecycle: { sessionKey, taskId, turnId, lease, closing } };
    });
    const c = makeCoordinator({ activeBrainTurns, deliverTerminal: pipeline.deliverTerminal });
    const spawned = await c.applyDecision({
      session,
      sessionKey: "feishu:p2p:ou_a",
      decision: { action: "spawn_new", title: "后台复核", brief: "先看一下", closure: "silent_ok", reason_code: "review" },
    });
    await vi.waitFor(() => expect(brain.turn).toHaveBeenCalledTimes(1));
    brain.isBusy = vi.fn(({ taskId }) => taskId === spawned.taskId);

    await c.applyDecision({
      session,
      sessionKey: "feishu:p2p:ou_a",
      decision: {
        action: "attach_existing",
        task_id: spawned.taskId,
        brief: "用户要求处理完必须告知",
        closure: "required",
        reason_code: "promise",
      },
    });
    gate.resolve();

    await vi.waitFor(() => expect(taskStore.getTask(spawned.taskId).status).toBe("completed"));
    expect(outbound.sendMessage).toHaveBeenCalledTimes(1);
    expect(taskStore.getTask(spawned.taskId).closure_mode).toBe("required");
  });

  it("silent_ok closes without a message and recycles only its tainted task resident", async () => {
    const activeBrainTurns = createActiveTurnRegistry().brainTurns;
    const replyEgress = createReplyProvenanceRegistry();
    brain.recycle = vi.fn();
    brain.turn = vi.fn(async ({ sessionKey, taskId }) => {
      const executionKey = `task:${taskId}`;
      const turnId = `turn:${taskId}`;
      const provenance = replyEgress.activate(sessionKey, { taskId, residentKey: executionKey });
      replyEgress.markTainted(sessionKey, "lark_read:mail_list", { taskId, residentKey: executionKey });
      const lease = activeBrainTurns.activate({ sessionKey, taskId, executionKey, turnId, purpose: "business" });
      activeBrainTurns.bindResident(sessionKey, lease, provenance.epoch, { taskId, executionKey });
      const closing = await activeBrainTurns.closeAdmissions(sessionKey, lease, { taskId, executionKey });
      return { turnLifecycle: { sessionKey, taskId, turnId, lease, closing } };
    });
    const deliverTerminal = vi.fn();
    const c = makeCoordinator({ activeBrainTurns, replyEgress, deliverTerminal });

    const out = await c.applyDecision({
      session,
      sessionKey: "feishu:p2p:ou_a",
      decision: { action: "spawn_new", title: "静默复核", brief: "复核", closure: "silent_ok", reason_code: "review" },
    });

    await vi.waitFor(() => expect(taskStore.getTask(out.taskId).status).toBe("completed"));
    expect(deliverTerminal).not.toHaveBeenCalled();
    expect(events).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "silent_closed", taskId: out.taskId }),
      expect.objectContaining({ type: "resident_taint_recycle", taskId: out.taskId }),
    ]));
    expect(brain.recycle).toHaveBeenCalledWith("feishu:p2p:ou_a", { taskId: out.taskId });
  });

  it("retries pending_send with the stable key and reuses a crash-residue assistant row", async () => {
    const source = sessions.append(session.id, {
      role: "user",
      senderOpenId: "ou_a",
      senderName: "甲",
      content: "帮我查",
      ts: 1,
    });
    const dispatch = taskStore.createDispatch({
      sessionId: session.id,
      sourceMessageIds: [source.id],
      responderAction: "reply",
      responderText: "我去查",
      mode: "p2p",
    });
    sessions.append(session.id, {
      role: "assistant",
      content: "我去查",
      platformMessageId: "om_recovered",
      ts: 2,
    });
    const deliverText = vi.fn(async () => ({ messageId: "om_recovered" }));
    const c = makeCoordinator({ deliverText });

    const recovered = await c.retryPendingSend({
      dispatchId: dispatch.id,
      session,
      sessionKey: "feishu:p2p:ou_a",
    });

    expect(deliverText).toHaveBeenCalledWith("feishu:p2p:ou_a", "我去查", {
      idempotencyKey: dispatch.outbound_idempotency_key,
    });
    expect(recovered.status).toBe("pending_review");
    expect(sessions.transcript(session.id).filter((row) => row.role === "assistant")).toHaveLength(1);
  });

  it("reconstructs original user items after restart and keeps the current batch out of recent transcript", async () => {
    sessions.append(session.id, { role: "user", content: "之前的话题", senderOpenId: "ou_a", ts: 1 });
    const source = sessions.append(session.id, {
      role: "user",
      senderOpenId: "ou_a",
      senderName: "甲",
      content: "对，改成周五",
      platformMessageId: "om_user",
      ts: 2,
    });
    const dispatch = taskStore.createDispatch({
      sessionId: session.id,
      sourceMessageIds: [source.id],
      responderAction: "reply",
      responderText: "收到",
      mode: "p2p",
    });
    const assistant = sessions.append(session.id, {
      role: "assistant",
      content: "收到",
      platformMessageId: "om_responder",
      ts: 3,
    });
    taskStore.markDispatchSent(dispatch.id, assistant.id);
    const dispatcher = {
      review: vi.fn(async () => ({ action: "no_reasoning", reason_code: "complete" })),
    };
    const c = makeCoordinator({ dispatcher });

    await c.processDispatch({
      dispatchId: dispatch.id,
      session,
      sessionKey: "feishu:p2p:ou_a",
      items: [],
      mode: "p2p",
    });

    expect(dispatcher.review).toHaveBeenCalledWith(expect.objectContaining({
      items: [expect.objectContaining({
        content: "对，改成周五",
        senderOpenId: "ou_a",
        senderName: "甲",
        platformMessageId: "om_user",
      })],
      recentRows: [expect.objectContaining({ content: "之前的话题" })],
    }));
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

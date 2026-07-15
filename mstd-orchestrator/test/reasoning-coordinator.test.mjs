import { describe, it, expect, beforeEach, vi } from "vitest";
import { openDb, migrate } from "../server/db/index.mjs";
import { createSessionStore } from "../server/sessions/store.mjs";
import { createReasoningTaskStore } from "../server/reasoning/task-store.mjs";
import { createReasoningRunStore } from "../server/reasoning/run-store.mjs";
import { createReasoningCoordinator } from "../server/reasoning/coordinator.mjs";
import { createActiveTurnRegistry } from "../server/sessions/active-turn.mjs";
import { createReplyPipeline } from "../server/gateway/reply-pipeline.mjs";
import { createReplyProvenanceRegistry } from "../server/safety/reply-egress.mjs";
import { createDispatcher } from "../server/models/dispatcher.mjs";
import { createModelLog } from "../server/models/model-log.mjs";

describe("reasoning coordinator", () => {
  let db, sessions, taskStore, runStore, session, brain, events;

  beforeEach(() => {
    db = openDb();
    migrate(db);
    sessions = createSessionStore(db);
    taskStore = createReasoningTaskStore(db);
    runStore = createReasoningRunStore(db);
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
      runStore,
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
      runId: expect.any(String),
      brief: "查周五空档",
    });
    const run = runStore.getRun(brain.turn.mock.calls[0][0].runId);
    expect(run).toMatchObject({ task_id: out.taskId, origin_kind: "dispatcher", closure_mode: "silent_ok" });
    expect(taskStore.listMessages(out.taskId).map((x) => x.id)).toContain(m.id);
    expect(events.some((e) => e.type === "task_created")).toBe(true);
  });

  it("attach_existing links input and steers a busy task", async () => {
    const task = taskStore.createTask({ sessionId: session.id, title: "改会议" });
    let openRun = runStore.createRun({
      taskId: task.id,
      originKind: "dispatcher",
      closureMode: "silent_ok",
      brief: "原任务",
    });
    openRun = runStore.startRun(openRun.id, { turnId: "turn-open", residentKey: `task:${task.id}` });
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
    expect(out).toMatchObject({ action: "attach_existing", steered: true, runId: openRun.id });
    expect(brain.steer).toHaveBeenCalledWith("feishu:p2p:ou_a", "用户改周五", {
      taskId: task.id,
      runId: out.runId,
    });
    expect(brain.turn).not.toHaveBeenCalled();
    expect(runStore.getRun(out.runId)).toMatchObject({ task_id: task.id, closure_mode: "required" });
  });

  it("idle existing task starts a new run without creating another task", async () => {
    const task = taskStore.createTask({ sessionId: session.id, title: "改会议" });
    brain.isBusy = vi.fn(() => false);
    const c = makeCoordinator({ deliverTerminal: vi.fn(async () => ({ messageId: "om_idle_required" })) });
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
    expect(out).toMatchObject({ started: true, runId: expect.any(String) });
    await vi.waitFor(() => expect(brain.turn).toHaveBeenCalledTimes(1));
    expect(brain.turn).toHaveBeenCalledWith(expect.objectContaining({ taskId: task.id, runId: out.runId }));
    await vi.waitFor(() => expect(runStore.getRun(out.runId).status).toBe("completed"));
    expect(taskStore.getTask(task.id).status).toBe("active");
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

  it("required run without a final reply sends one daemon closure and keeps the task active", async () => {
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
    brain.turn = vi.fn(async ({ sessionKey, taskId, runId }) => {
      const executionKey = `task:${taskId}`;
      const turnId = `turn:${taskId}`;
      const identity = { taskId, runId, executionKey };
      const lease = activeBrainTurns.activate({ sessionKey, ...identity, turnId, purpose: "business" });
      activeBrainTurns.bindResident(sessionKey, lease, 1, identity);
      const closing = await activeBrainTurns.closeAdmissions(sessionKey, lease, identity);
      return { turnLifecycle: { sessionKey, ...identity, turnId, lease, closing } };
    });
    const c = makeCoordinator({ activeBrainTurns, deliverTerminal: pipeline.deliverTerminal });

    const out = await c.applyDecision({
      session,
      sessionKey: "feishu:p2p:ou_a",
      decision: { action: "spawn_new", title: "必须闭合", brief: "处理", closure: "required", reason_code: "promise" },
    });

    await vi.waitFor(() => expect(runStore.getRun(out.runId).status).toBe("completed"));
    expect(taskStore.getTask(out.taskId).status).toBe("active");
    expect(outbound.sendMessage).toHaveBeenCalledTimes(1);
    expect(outbound.sendMessage).toHaveBeenCalledWith(expect.objectContaining({
      text: expect.stringContaining("没能生成"),
    }));
    expect(activeBrainTurns.resolve("feishu:p2p:ou_a", { taskId: out.taskId, executionKey: `task:${out.taskId}` })).toBeNull();
  });

  it("renders no-lifecycle finalText through Responder and never sends the raw reasoner text", async () => {
    const deliverTerminal = vi.fn(async () => ({ messageId: "om_rendered" }));
    const responder = {
      renderHandoff: vi.fn(async () => ({ text: "给用户看的正式结论" })),
    };
    brain.turn = vi.fn(async () => ({ finalText: "RAW_REASONER_INTERNAL_RESULT" }));
    const c = makeCoordinator({ responder, deliverTerminal });

    const out = await c.applyDecision({
      session,
      sessionKey: "feishu:p2p:ou_a",
      decision: { action: "spawn_new", title: "正式闭合", brief: "处理", closure: "required", reason_code: "promise" },
    });

    await vi.waitFor(() => expect(runStore.getRun(out.runId).status).toBe("completed"));
    expect(responder.renderHandoff).toHaveBeenCalledWith(expect.objectContaining({
      sessionKey: "feishu:p2p:ou_a",
      taskId: out.taskId,
      brief: "RAW_REASONER_INTERNAL_RESULT",
      kind: "message",
      deliverKind: "p2p",
    }));
    expect(deliverTerminal).toHaveBeenCalledTimes(1);
    expect(deliverTerminal).toHaveBeenCalledWith(expect.objectContaining({
      text: "给用户看的正式结论",
      idempotencyKey: `run:${out.runId}:terminal`,
    }));
    expect(JSON.stringify(deliverTerminal.mock.calls)).not.toContain("RAW_REASONER_INTERNAL_RESULT");
    expect(runStore.getRun(out.runId)).toMatchObject({
      closure_state: "sent",
      terminal_message_id: "om_rendered",
    });
  });

  it("closes a no-lifecycle reasoner failure exactly once with deterministic fallback when Responder also fails", async () => {
    const deliverTerminal = vi.fn(async () => ({ messageId: "om_fallback" }));
    const responder = {
      renderHandoff: vi.fn(async () => { throw new Error("responder provider down"); }),
    };
    brain.turn = vi.fn(async () => { throw new Error("secret provider stack trace"); });
    const c = makeCoordinator({ responder, deliverTerminal, log: vi.fn() });

    const out = await c.applyDecision({
      session,
      sessionKey: "feishu:p2p:ou_a",
      decision: { action: "spawn_new", title: "失败闭合", brief: "处理", closure: "required", reason_code: "promise" },
    });

    await vi.waitFor(() => expect(runStore.getRun(out.runId).status).toBe("completed"));
    expect(deliverTerminal).toHaveBeenCalledTimes(1);
    expect(deliverTerminal).toHaveBeenCalledWith(expect.objectContaining({
      text: "这次处理没能生成可安全发送的正式答复，请稍后重试。",
      source: "daemon_terminal_fallback",
      idempotencyKey: `run:${out.runId}:terminal`,
    }));
    expect(JSON.stringify(deliverTerminal.mock.calls)).not.toContain("secret provider stack trace");
    expect(runStore.getRun(out.runId)).toMatchObject({
      closure_state: "safe_fallback_sent",
      terminal_message_id: "om_fallback",
    });
  });

  it("recovers queued runs in durable order without duplicate execution", async () => {
    const gate = Promise.withResolvers();
    brain.turn = vi.fn(async ({ taskId }) => {
      if (brain.turn.mock.calls.length === 1) await gate.promise;
      return { finalText: taskId };
    });
    const taskA = taskStore.createTask({ sessionId: session.id, title: "A" });
    const taskB = taskStore.createTask({ sessionId: session.id, title: "B" });
    const runA = runStore.createRun({ taskId: taskA.id, originKind: "dispatcher", closureMode: "silent_ok", brief: "A" });
    const runB = runStore.createRun({ taskId: taskB.id, originKind: "dispatcher", closureMode: "silent_ok", brief: "B" });
    const c = makeCoordinator({ maxReasonersPerSession: 1 });
    const resolveSession = (id) => id === session.id ? session : null;

    const first = await c.recoverRuns({ resolveSession });
    const second = await c.recoverRuns({ resolveSession });

    expect(first.map((x) => x.runId)).toEqual([runA.id, runB.id]);
    expect(second).toEqual([
      expect.objectContaining({ runId: runA.id, status: "already_scheduled" }),
      expect.objectContaining({ runId: runB.id, status: "already_scheduled" }),
    ]);
    await vi.waitFor(() => expect(brain.turn).toHaveBeenCalledTimes(1));
    expect(brain.turn.mock.calls[0][0].runId).toBe(runA.id);
    gate.resolve();
    await vi.waitFor(() => expect(brain.turn).toHaveBeenCalledTimes(2));
    expect(brain.turn.mock.calls[1][0].runId).toBe(runB.id);
    await vi.waitFor(() => expect(runStore.getRun(runB.id).status).toBe("completed"));
  });

  it("recovers stale required and silent runs without replaying the reasoner", async () => {
    const requiredTask = taskStore.createTask({ sessionId: session.id, title: "required" });
    const silentTask = taskStore.createTask({ sessionId: session.id, title: "silent" });
    const required = runStore.createRun({ taskId: requiredTask.id, originKind: "dispatcher", closureMode: "required", brief: "R" });
    const silent = runStore.createRun({ taskId: silentTask.id, originKind: "dispatcher", closureMode: "silent_ok", brief: "S" });
    runStore.startRun(required.id, { turnId: "old-required", residentKey: `task:${requiredTask.id}` });
    runStore.startRun(silent.id, { turnId: "old-silent", residentKey: `task:${silentTask.id}` });
    const responder = { renderHandoff: vi.fn(async () => ({ text: "恢复后的安全说明" })) };
    const deliverTerminal = vi.fn(async () => ({ messageId: "om_recovered_run" }));
    const c = makeCoordinator({ responder, deliverTerminal });

    const recovered = await c.recoverRuns({ resolveSession: () => session });

    expect(recovered).toEqual(expect.arrayContaining([
      expect.objectContaining({ runId: required.id, status: "closed" }),
      expect.objectContaining({ runId: silent.id, status: "interrupted" }),
    ]));
    expect(brain.turn).not.toHaveBeenCalled();
    expect(runStore.getRun(required.id)).toMatchObject({ status: "completed", closure_state: "sent" });
    expect(runStore.getRun(silent.id)).toMatchObject({ status: "interrupted" });
    expect(deliverTerminal).toHaveBeenCalledWith(expect.objectContaining({
      idempotencyKey: `run:${required.id}:terminal`,
      text: "恢复后的安全说明",
    }));
  });

  it("does not immediately retry a failed terminal delivery inside the same run job", async () => {
    const deliverTerminal = vi.fn(async () => { throw new Error("platform unavailable"); });
    const responder = { renderHandoff: vi.fn(async () => ({ text: "正式结论" })) };
    const c = makeCoordinator({ responder, deliverTerminal, log: vi.fn() });

    const out = await c.applyDecision({
      session,
      sessionKey: "feishu:p2p:ou_a",
      decision: { action: "spawn_new", title: "投递失败", brief: "处理", closure: "required", reason_code: "promise" },
    });

    await vi.waitFor(() => expect(runStore.getRun(out.runId).status).toBe("closing"));
    await vi.waitFor(() => expect(events).toContainEqual(expect.objectContaining({
      type: "run_failed",
      runId: out.runId,
    })));
    expect(deliverTerminal).toHaveBeenCalledTimes(1);
    expect(runStore.getRun(out.runId)).toMatchObject({ closure_state: "pending_send" });
  });

  it("continues startup recovery after one stale run delivery fails", async () => {
    const taskA = taskStore.createTask({ sessionId: session.id, title: "A" });
    const taskB = taskStore.createTask({ sessionId: session.id, title: "B" });
    const runA = runStore.createRun({ taskId: taskA.id, originKind: "dispatcher", closureMode: "required", brief: "A" });
    const runB = runStore.createRun({ taskId: taskB.id, originKind: "dispatcher", closureMode: "required", brief: "B" });
    runStore.startRun(runA.id, { turnId: "old-a", residentKey: `task:${taskA.id}` });
    runStore.startRun(runB.id, { turnId: "old-b", residentKey: `task:${taskB.id}` });
    const deliverTerminal = vi.fn()
      .mockRejectedValueOnce(new Error("first unavailable"))
      .mockResolvedValueOnce({ messageId: "om_second" });
    const responder = { renderHandoff: vi.fn(async () => ({ text: "安全恢复说明" })) };
    const c = makeCoordinator({ responder, deliverTerminal, log: vi.fn() });

    const recovered = await c.recoverRuns({ resolveSession: () => session });

    expect(recovered).toEqual(expect.arrayContaining([
      expect.objectContaining({ runId: runA.id, status: "pending_send" }),
      expect.objectContaining({ runId: runB.id, status: "closed" }),
    ]));
    expect(runStore.getRun(runA.id)).toMatchObject({ status: "closing", closure_state: "pending_send" });
    expect(runStore.getRun(runB.id)).toMatchObject({ status: "completed", closure_state: "sent" });
    expect(deliverTerminal).toHaveBeenCalledTimes(2);
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
    brain.turn = vi.fn(async ({ sessionKey, taskId, runId }) => {
      await gate.promise;
      const executionKey = `task:${taskId}`;
      const turnId = `turn:${taskId}`;
      const identity = { taskId, runId, executionKey };
      const lease = activeBrainTurns.activate({ sessionKey, ...identity, turnId, purpose: "business" });
      activeBrainTurns.bindResident(sessionKey, lease, 1, identity);
      const closing = await activeBrainTurns.closeAdmissions(sessionKey, lease, identity);
      return { turnLifecycle: { sessionKey, ...identity, turnId, lease, closing } };
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

    await vi.waitFor(() => expect(runStore.getRun(spawned.runId).status).toBe("completed"));
    expect(outbound.sendMessage).toHaveBeenCalledTimes(1);
    expect(runStore.getRun(spawned.runId).closure_mode).toBe("required");
    expect(taskStore.getTask(spawned.taskId).status).toBe("active");
  });

  it("silent_ok closes without a message and recycles only its tainted task resident", async () => {
    const activeBrainTurns = createActiveTurnRegistry().brainTurns;
    const replyEgress = createReplyProvenanceRegistry();
    brain.recycle = vi.fn();
    brain.turn = vi.fn(async ({ sessionKey, taskId, runId }) => {
      const executionKey = `task:${taskId}`;
      const turnId = `turn:${taskId}`;
      const identity = { taskId, runId, executionKey };
      const provenance = replyEgress.activate(sessionKey, { taskId, residentKey: executionKey });
      replyEgress.markTainted(sessionKey, "lark_read:mail_list", { taskId, residentKey: executionKey });
      const lease = activeBrainTurns.activate({ sessionKey, ...identity, turnId, purpose: "business" });
      activeBrainTurns.bindResident(sessionKey, lease, provenance.epoch, identity);
      const closing = await activeBrainTurns.closeAdmissions(sessionKey, lease, identity);
      return { turnLifecycle: { sessionKey, ...identity, turnId, lease, closing } };
    });
    const deliverTerminal = vi.fn();
    const c = makeCoordinator({ activeBrainTurns, replyEgress, deliverTerminal });

    const out = await c.applyDecision({
      session,
      sessionKey: "feishu:p2p:ou_a",
      decision: { action: "spawn_new", title: "静默复核", brief: "复核", closure: "silent_ok", reason_code: "review" },
    });

    await vi.waitFor(() => expect(runStore.getRun(out.runId).status).toBe("completed"));
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

  it("records a real dispatch-to-terminal event timeline correlated by dispatch/task/run", async () => {
    const source = sessions.append(session.id, {
      role: "user",
      senderOpenId: "ou_a",
      content: "查会议室",
      ts: 1,
    });
    const dispatch = taskStore.createDispatch({
      sessionId: session.id,
      sourceMessageIds: [source.id],
      responderAction: "reply",
      responderText: "我去查",
      mode: "p2p",
    });
    const assistant = sessions.append(session.id, { role: "assistant", content: "我去查", ts: 2 });
    taskStore.markDispatchSent(dispatch.id, assistant.id);
    const modelLog = createModelLog(db, { now: () => 10 });
    const dispatcher = createDispatcher({
      caller: { call: vi.fn(async () => ({
        text: '{"action":"spawn_new","title":"查会议室","brief":"查周五空档","closure":"silent_ok","reason_code":"needs_tools"}',
        model: "dispatcher-model",
        usage: null,
      })) },
      onEvent: modelLog.record,
    });
    const c = createReasoningCoordinator({
      taskStore,
      runStore,
      brain,
      store: sessions,
      dispatcher,
      onEvent: modelLog.record,
    });

    const processed = await c.processDispatch({
      dispatchId: dispatch.id,
      session,
      sessionKey: "feishu:p2p:ou_a",
    });
    await vi.waitFor(() => expect(runStore.getRun(processed.result.runId).status).toBe("completed"));

    const timeline = modelLog.list({ dispatchId: dispatch.id });
    expect(timeline.map((row) => row.kind)).toEqual(expect.arrayContaining([
      "dispatcher_started",
      "dispatcher_decision",
      "task_created",
      "reasoner_started",
      "silent_closed",
      "reasoner_completed",
    ]));
    for (const kind of ["task_created", "reasoner_started", "silent_closed", "reasoner_completed"]) {
      expect(timeline.find((row) => row.kind === kind)).toMatchObject({
        task_id: processed.result.taskId,
        run_id: processed.result.runId,
        dispatch_id: dispatch.id,
      });
    }
  });

  it("dispatcher error in addressed mode spawns required work and produces a terminal delivery", async () => {
    const source = sessions.append(session.id, {
      role: "user",
      senderOpenId: "ou_a",
      content: "帮我核实这件事",
      ts: 1,
    });
    const dispatch = taskStore.createDispatch({
      sessionId: session.id,
      sourceMessageIds: [source.id],
      responderAction: "reply",
      responderText: "收到，我先处理一下。",
      mode: "addressed",
    });
    const assistant = sessions.append(session.id, {
      role: "assistant",
      content: "收到，我先处理一下。",
      ts: 2,
    });
    taskStore.markDispatchSent(dispatch.id, assistant.id);
    const deliverTerminal = vi.fn(async () => ({ messageId: "om_dispatcher_fallback_terminal" }));
    const dispatcher = createDispatcher({
      caller: { call: vi.fn(async () => { throw new Error("dispatcher unavailable"); }) },
    });
    const c = createReasoningCoordinator({
      taskStore,
      runStore,
      brain,
      store: sessions,
      dispatcher,
      deliverTerminal,
      onEvent: (event) => events.push(event),
    });

    const processed = await c.processDispatch({
      dispatchId: dispatch.id,
      session,
      sessionKey: "feishu:p2p:ou_a",
      mode: "addressed",
    });

    expect(processed.decision).toMatchObject({
      action: "spawn_new",
      closure: "required",
      reason_code: "dispatcher_fallback_spawn",
    });
    await vi.waitFor(() => expect(runStore.getRun(processed.result.runId).status).toBe("completed"));
    expect(deliverTerminal).toHaveBeenCalledTimes(1);
    expect(deliverTerminal).toHaveBeenCalledWith(expect.objectContaining({
      idempotencyKey: `run:${processed.result.runId}:terminal`,
      source: "daemon_terminal_fallback",
    }));
    expect(runStore.getRun(processed.result.runId)).toMatchObject({
      closure_mode: "required",
      closure_state: "safe_fallback_sent",
      terminal_message_id: "om_dispatcher_fallback_terminal",
    });
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

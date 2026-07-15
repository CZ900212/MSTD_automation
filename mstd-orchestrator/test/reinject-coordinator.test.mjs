import { beforeEach, describe, expect, it, vi } from "vitest";
import { openDb, migrate } from "../server/db/index.mjs";
import { createSessionStore } from "../server/sessions/store.mjs";
import { createReasoningTaskStore } from "../server/reasoning/task-store.mjs";
import { createReasoningRunStore } from "../server/reasoning/run-store.mjs";
import { createReasoningCoordinator } from "../server/reasoning/coordinator.mjs";
import { createReinjector } from "../server/jobs/reinjector.mjs";

const SESSION_KEY = "feishu:p2p:ou_origin";

function completion(overrides = {}) {
  return {
    jobId: "job-1",
    sessionKey: SESSION_KEY,
    sessionVersion: 0,
    taskId: "task-origin",
    originRunId: "run-origin",
    dispatchId: "dispatch-origin",
    ok: true,
    result: "后台结果",
    ...overrides,
  };
}

describe("reinjector → reasoning coordinator provenance", () => {
  let db, sessions, taskStore, runStore, session, task, parentRun, brain, coordinator, reinjector;

  function coordinatorDeliveryDeps() {
    return {
      responder: { renderHandoff: vi.fn(async ({ brief }) => ({ text: `正式答复：${brief}` })) },
      deliverTerminal: vi.fn(async ({ idempotencyKey }) => ({ messageId: `om:${idempotencyKey}` })),
    };
  }

  beforeEach(() => {
    db = openDb();
    migrate(db);
    sessions = createSessionStore(db);
    taskStore = createReasoningTaskStore(db);
    runStore = createReasoningRunStore(db);
    session = sessions.getOrCreate(SESSION_KEY, { kind: "p2p" });
    task = taskStore.createTask({ id: "task-origin", sessionId: session.id, title: "原任务" });
    parentRun = runStore.createRun({
      id: "run-origin",
      taskId: task.id,
      originKind: "dispatcher",
      closureMode: "silent_ok",
      brief: "原始工作",
    });
    runStore.closeSilent(parentRun.id);
    brain = {
      turn: vi.fn(async () => ({ finalText: "done" })),
      steer: vi.fn(() => true),
      isBusy: vi.fn(() => false),
    };
    coordinator = createReasoningCoordinator({
      taskStore,
      runStore,
      brain,
      store: sessions,
      ...coordinatorDeliveryDeps(),
    });
    reinjector = createReinjector({
      store: sessions,
      actors: { enqueue: vi.fn((_key, callback) => callback()) },
      brain,
      outbound: { editMessage: vi.fn(async () => ({})) },
      coordinator,
    });
  });

  it("idle active task starts a child run and preserves originating identity", async () => {
    const out = await reinjector.onJobComplete(completion());

    expect(out).toMatchObject({ status: "started", taskId: task.id, runId: expect.any(String) });
    const child = runStore.getRun(out.runId);
    expect(child).toMatchObject({
      task_id: task.id,
      parent_run_id: parentRun.id,
      origin_kind: "reinject",
      origin_id: "job-1",
      closure_mode: "required",
    });
    await vi.waitFor(() => expect(brain.turn).toHaveBeenCalledWith(expect.objectContaining({
      taskId: task.id,
      runId: out.runId,
      dispatchId: "dispatch-origin",
      contextEnvelopes: [expect.objectContaining({ source: "background", scope: SESSION_KEY })],
    })));
  });

  it("queued run consumes every input that arrived while it waited for a fairness slot", async () => {
    coordinator = createReasoningCoordinator({
      taskStore,
      runStore,
      brain,
      store: sessions,
      maxReasonersPerSession: 1,
      ...coordinatorDeliveryDeps(),
    });
    reinjector = createReinjector({
      store: sessions,
      actors: { enqueue: vi.fn((_key, callback) => callback()) },
      brain,
      outbound: { editMessage: vi.fn(async () => ({})) },
      coordinator,
    });
    const blocker = taskStore.createTask({ sessionId: session.id, title: "占用公平槽" });
    const blockerRun = runStore.createRun({ taskId: blocker.id, originKind: "dispatcher", closureMode: "silent_ok", brief: "占用" });
    let releaseBlocker;
    brain.turn.mockImplementationOnce(() => new Promise((resolve) => { releaseBlocker = resolve; }));
    await coordinator.startReasoner({ session, sessionKey: SESSION_KEY, task: blocker, run: blockerRun, brief: "占用" });
    await vi.waitFor(() => expect(runStore.getRun(blockerRun.id)?.status).toBe("running"));

    const first = await reinjector.onJobComplete(completion({ jobId: "job-queued-a" }));
    const second = await reinjector.onJobComplete(completion({ jobId: "job-queued-b", result: "排队期间第二个结果" }));
    expect(first).toMatchObject({ status: "queued" });
    expect(second).toMatchObject({ status: "queued", runId: first.runId });
    expect(runStore.pendingInputs(first.runId)).toHaveLength(2);

    releaseBlocker({ finalText: "released" });
    await vi.waitFor(() => expect(brain.turn).toHaveBeenCalledTimes(2));
    const queuedCall = brain.turn.mock.calls[1][0];
    expect(queuedCall.runId).toBe(first.runId);
    expect(queuedCall.contextEnvelopes).toHaveLength(2);
    expect(queuedCall.contextEnvelopes).toEqual(expect.arrayContaining([
      expect.objectContaining({ content: "后台结果" }),
      expect.objectContaining({ content: "排队期间第二个结果" }),
    ]));
    await vi.waitFor(() => expect(runStore.pendingInputs(first.runId)).toHaveLength(0));
  });

  it("running origin task attaches tool result to the open run and steers instead of creating another run", async () => {
    const open = runStore.createRun({
      id: "run-open",
      taskId: task.id,
      parentRunId: parentRun.id,
      originKind: "dispatcher",
      closureMode: "silent_ok",
      brief: "继续处理",
    });
    runStore.startRun(open.id, { turnId: "turn-open", residentKey: `task:${task.id}` });
    brain.isBusy.mockReturnValue(true);

    const out = await reinjector.onJobComplete(completion({ jobId: "job-running" }));

    expect(out).toMatchObject({ status: "attached", runId: open.id, steered: true });
    expect(runStore.currentOpenRun(task.id)).toMatchObject({ id: open.id, closure_mode: "required" });
    expect(brain.steer).toHaveBeenCalledWith(SESSION_KEY, expect.stringContaining("job-running"), {
      taskId: task.id,
      runId: open.id,
      contextEnvelope: expect.objectContaining({ source: "background", content: "后台结果" }),
    });
    expect(db.prepare("SELECT COUNT(*) AS n FROM reasoning_runs WHERE task_id = ?").get(task.id).n).toBe(2);
  });

  it.each([
    ["queued", "queued"],
    ["closing", "attached"],
  ])("open %s run stores a pending tool result without a second open run", async (state, expectedStatus) => {
    let open = runStore.createRun({
      id: `run-${state}`,
      taskId: task.id,
      parentRunId: parentRun.id,
      originKind: "dispatcher",
      closureMode: "silent_ok",
      brief: "继续处理",
    });
    if (state === "closing") {
      open = runStore.startRun(open.id, { turnId: "turn-closing", residentKey: `task:${task.id}` });
      open = runStore.upgradeClosure(open.id, "required");
      open = runStore.claimClosure(open.id);
    }

    const out = await reinjector.onJobComplete(completion({ jobId: `job-${state}` }));

    expect(out).toMatchObject({ status: expectedStatus, runId: open.id, steered: false });
    expect(runStore.currentOpenRun(task.id).id).toBe(open.id);
    expect(db.prepare("SELECT COUNT(*) AS n FROM reasoning_run_inputs WHERE run_id = ?").get(open.id).n).toBe(1);
    expect(db.prepare("SELECT COUNT(*) AS n FROM reasoning_runs WHERE task_id = ?").get(task.id).n).toBe(2);
  });

  it("closing run completion automatically carries every pending input into one child run", async () => {
    let releaseTurn;
    brain.turn.mockImplementationOnce(() => new Promise((resolve) => { releaseTurn = resolve; }));
    const first = await coordinator.attachOrStart({
      session,
      sessionKey: SESSION_KEY,
      taskId: task.id,
      parentRunId: parentRun.id,
      originKind: "dispatcher",
      originId: "dispatch-closing-next",
      dispatchId: "dispatch-closing-next",
      sessionVersion: 0,
      brief: "即将闭合",
      closureMode: "required",
    });
    await vi.waitFor(() => expect(runStore.getRun(first.runId)?.status).toBe("running"));
    runStore.claimClosure(first.runId);

    const attachedA = await reinjector.onJobComplete(completion({ jobId: "job-closing-next-a" }));
    const attachedB = await reinjector.onJobComplete(completion({ jobId: "job-closing-next-b", result: "第二个后台结果" }));
    expect(attachedA).toMatchObject({ status: "attached", runId: first.runId });
    expect(attachedB).toMatchObject({ status: "attached", runId: first.runId });

    releaseTurn({ finalText: "closed" });
    await vi.waitFor(() => expect(brain.turn).toHaveBeenCalledTimes(2));
    const childCall = brain.turn.mock.calls[1][0];
    expect(childCall.runId).not.toBe(first.runId);
    expect(childCall.contextEnvelopes).toHaveLength(2);
    expect(childCall.contextEnvelopes).toEqual(expect.arrayContaining([
      expect.objectContaining({ content: "后台结果" }),
      expect.objectContaining({ content: "第二个后台结果" }),
    ]));
    expect(runStore.getRun(childCall.runId)).toMatchObject({
      task_id: task.id,
      parent_run_id: first.runId,
      origin_kind: "reinject",
      origin_id: expect.stringMatching(/^job-closing-next-[ab]$/),
      closure_mode: "required",
    });
    expect(db.prepare("SELECT COUNT(*) AS n FROM reasoning_run_inputs WHERE run_id = ? AND status = 'delivered'").get(childCall.runId).n).toBe(2);
  });

  it("terminal task is controlled and never implicitly reopened", async () => {
    taskStore.resolveTask(task.id);

    const out = await reinjector.onJobComplete(completion({ jobId: "job-terminal" }));

    expect(out).toMatchObject({ status: "controlled", reason: "terminal_task" });
    expect(brain.turn).not.toHaveBeenCalled();
    expect(db.prepare("SELECT COUNT(*) AS n FROM reasoning_runs WHERE task_id = ?").get(task.id).n).toBe(1);
  });

  it("cross-session or fabricated originating identity is controlled with zero side effects", async () => {
    const other = sessions.getOrCreate("feishu:p2p:ou_other", { kind: "p2p" });
    const foreignTask = taskStore.createTask({ sessionId: other.id, title: "外会话" });
    const foreignRun = runStore.createRun({ taskId: foreignTask.id, originKind: "dispatcher", closureMode: "silent_ok" });
    runStore.closeSilent(foreignRun.id);

    const cross = await reinjector.onJobComplete(completion({
      jobId: "job-cross",
      taskId: foreignTask.id,
      originRunId: foreignRun.id,
    }));
    const fabricated = await reinjector.onJobComplete(completion({
      jobId: "job-fabricated",
      taskId: "missing",
      originRunId: "missing",
    }));

    expect(cross).toMatchObject({ status: "controlled", reason: "task_session_mismatch" });
    expect(fabricated).toMatchObject({ status: "controlled", reason: "missing_task" });
    expect(brain.turn).not.toHaveBeenCalled();
  });
});

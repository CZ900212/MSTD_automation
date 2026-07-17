import { describe, it, expect, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { openDb, migrate } from "../server/db/index.mjs";
import { createSessionStore } from "../server/sessions/store.mjs";
import { createReasoningTaskStore } from "../server/reasoning/task-store.mjs";
import { createReasoningRunStore } from "../server/reasoning/run-store.mjs";

const MIGRATION = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), "../server/db/migrations/021_reasoning_runs.sql"),
  "utf8",
);

describe("021_reasoning_runs migration shape", () => {
  it("defines durable runs, dispatch associations, and one-open-run enforcement", () => {
    expect(MIGRATION).toMatch(/CREATE TABLE IF NOT EXISTS reasoning_runs/);
    expect(MIGRATION).toMatch(/CREATE TABLE IF NOT EXISTS reasoning_run_dispatches/);
    for (const value of [
      "queued", "running", "closing", "completed", "failed", "interrupted", "cancelled",
      "open", "pending_send", "sent", "safe_fallback_sent", "silent_closed", "cancelled",
    ]) {
      expect(MIGRATION).toContain(`'${value}'`);
    }
    expect(MIGRATION).toMatch(/CREATE UNIQUE INDEX[\s\S]*WHERE status IN \('queued', 'running', 'closing'\)/);
    expect(MIGRATION).toContain("terminal_idempotency_key");
    expect(MIGRATION).toContain("origin_dispatch_id");
    expect(MIGRATION).toContain("parent_run_id");
  });

  it("applies additively after 019/020", () => {
    const db = openDb();
    migrate(db);
    const names = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((r) => r.name);
    expect(names).toEqual(expect.arrayContaining(["reasoning_runs", "reasoning_run_dispatches"]));
    expect(db.prepare("SELECT name FROM schema_migrations WHERE name = ?").get("021_reasoning_runs.sql"))
      .toBeTruthy();
    expect(db.prepare("SELECT name FROM schema_migrations WHERE name = ?").get("019_reasoning_tasks.sql"))
      .toBeTruthy();
    expect(db.prepare("SELECT name FROM schema_migrations WHERE name = ?").get("020_reasoning_observability.sql"))
      .toBeTruthy();
    db.close();
  });
});

describe("createReasoningRunStore", () => {
  let db, sessions, taskStore, runStore, session, other, task, clock;

  beforeEach(() => {
    db = openDb();
    migrate(db);
    sessions = createSessionStore(db);
    clock = 10_000;
    taskStore = createReasoningTaskStore(db, { now: () => clock });
    runStore = createReasoningRunStore(db, { now: () => clock });
    session = sessions.getOrCreate("feishu:p2p:ou_a", { kind: "p2p" });
    other = sessions.getOrCreate("feishu:p2p:ou_b", { kind: "p2p" });
    task = taskStore.createTask({ sessionId: session.id, title: "查会议室", closureMode: "required" });
  });

  function dispatchFor(targetSession, content = "查一下") {
    const message = sessions.append(targetSession.id, { role: "user", content, ts: clock });
    return taskStore.createDispatch({
      sessionId: targetSession.id,
      sourceMessageIds: [message.id],
      responderAction: "no_reply",
      mode: "p2p",
    });
  }

  it("creates a server-issued queued run and durably links its origin dispatch", () => {
    const dispatch = dispatchFor(session);
    const run = runStore.createRun({
      taskId: task.id,
      originDispatchId: dispatch.id,
      originKind: "dispatch",
      originId: dispatch.id,
      closureMode: "silent_ok",
      brief: "查周五空档",
    });

    expect(run.id).toMatch(/[0-9a-f-]{36}/i);
    expect(run.status).toBe("queued");
    expect(run.closure_mode).toBe("silent_ok");
    expect(run.closure_state).toBe("open");
    expect(run.terminal_idempotency_key).toBe(`run:${run.id}:terminal`);
    expect(runStore.currentOpenRun(task.id).id).toBe(run.id);
    expect(runStore.listDispatches(run.id)).toEqual([
      expect.objectContaining({ dispatch_id: dispatch.id, relation: "origin" }),
    ]);
  });

  it("enforces one open run per task while allowing different tasks to run concurrently", () => {
    const first = runStore.createRun({ taskId: task.id, closureMode: "silent_ok", originKind: "manual" });
    expect(() => runStore.createRun({ taskId: task.id, closureMode: "required", originKind: "manual" }))
      .toThrow(/open run|进行中的 run/);

    const taskB = taskStore.createTask({ sessionId: session.id, title: "订午饭" });
    const second = runStore.createRun({ taskId: taskB.id, closureMode: "required", originKind: "manual" });
    expect(second.id).not.toBe(first.id);
    expect(runStore.currentOpenRun(taskB.id).id).toBe(second.id);
  });

  it("rejects terminal tasks, cross-session dispatches, and cross-task parent runs", () => {
    const foreignDispatch = dispatchFor(other, "别的会话");
    expect(() => runStore.createRun({
      taskId: task.id,
      originDispatchId: foreignDispatch.id,
      closureMode: "silent_ok",
      originKind: "dispatch",
    })).toThrow(/跨会话/);

    const otherTask = taskStore.createTask({ sessionId: session.id, title: "另一任务" });
    const parent = runStore.createRun({ taskId: otherTask.id, closureMode: "silent_ok", originKind: "manual" });
    runStore.closeSilent(parent.id);
    expect(() => runStore.createRun({
      taskId: task.id,
      parentRunId: parent.id,
      closureMode: "silent_ok",
      originKind: "reinject",
    })).toThrow(/parent.*task|父 run/i);

    taskStore.cancelTask(task.id, { summary: "用户取消" });
    expect(() => runStore.createRun({ taskId: task.id, closureMode: "silent_ok", originKind: "manual" }))
      .toThrow(/active/);
  });

  it("moves queued -> running -> closing -> completed with a stable terminal receipt", () => {
    const run = runStore.createRun({ taskId: task.id, closureMode: "required", originKind: "manual" });
    clock += 1;
    expect(runStore.startRun(run.id, { turnId: "turn-1", residentKey: `task:${task.id}` })).toMatchObject({
      status: "running",
      turn_id: "turn-1",
      resident_key: `task:${task.id}`,
      started_at: clock,
    });
    clock += 1;
    const claimed = runStore.claimClosure(run.id);
    expect(claimed).toMatchObject({ status: "closing", closure_state: "pending_send" });
    expect(runStore.claimClosure(run.id).id).toBe(run.id);

    clock += 1;
    const closed = runStore.recordTerminal(run.id, { messageId: "om_terminal" });
    expect(closed).toMatchObject({
      status: "completed",
      closure_state: "sent",
      terminal_message_id: "om_terminal",
      completed_at: clock,
    });
    expect(runStore.recordTerminal(run.id, { messageId: "om_terminal" }).id).toBe(run.id);
    expect(() => runStore.recordTerminal(run.id, { messageId: "om_other" })).toThrow(/terminal|消息/i);
    expect(runStore.currentOpenRun(task.id)).toBeNull();
  });

  it("keeps required monotonic within one run but starts the next run from its own closure", () => {
    const first = runStore.createRun({ taskId: task.id, closureMode: "silent_ok", originKind: "manual" });
    expect(runStore.upgradeClosure(first.id, "required").closure_mode).toBe("required");
    expect(runStore.upgradeClosure(first.id, "silent_ok").closure_mode).toBe("required");
    runStore.startRun(first.id, { turnId: "turn-1", residentKey: `task:${task.id}` });
    runStore.claimClosure(first.id);
    runStore.recordTerminal(first.id, { messageId: "om_first" });

    const second = runStore.createRun({ taskId: task.id, closureMode: "silent_ok", originKind: "manual" });
    expect(second.closure_mode).toBe("silent_ok");
    expect(taskStore.getTask(task.id).closure_mode).toBe("required");
  });

  it("supports silent close, safe fallback receipt, interruption, and ordered recovery queries", () => {
    const silentTask = taskStore.createTask({ sessionId: session.id, title: "静默" });
    const silent = runStore.createRun({ taskId: silentTask.id, closureMode: "silent_ok", originKind: "manual" });
    expect(runStore.closeSilent(silent.id)).toMatchObject({ status: "completed", closure_state: "silent_closed" });

    clock += 1;
    const fallbackTask = taskStore.createTask({ sessionId: session.id, title: "兜底" });
    const fallback = runStore.createRun({ taskId: fallbackTask.id, closureMode: "required", originKind: "manual" });
    runStore.startRun(fallback.id, { turnId: "turn-f", residentKey: `task:${fallbackTask.id}` });
    runStore.claimClosure(fallback.id);
    expect(runStore.recordTerminal(fallback.id, { messageId: "om_fallback", safeFallback: true })).toMatchObject({
      closure_state: "safe_fallback_sent",
    });

    clock += 1;
    const interruptedTask = taskStore.createTask({ sessionId: session.id, title: "中断" });
    const interrupted = runStore.createRun({ taskId: interruptedTask.id, closureMode: "silent_ok", originKind: "manual" });
    runStore.startRun(interrupted.id, { turnId: "turn-i", residentKey: `task:${interruptedTask.id}` });
    expect(runStore.listRecoverableRuns().map((row) => row.id)).toContain(interrupted.id);
    expect(runStore.markInterrupted(interrupted.id, { failureSummary: "process restart" })).toMatchObject({
      status: "interrupted",
      failure_summary: "process restart",
    });
    expect(runStore.listRecoverableRuns().map((row) => row.id)).not.toContain(interrupted.id);
  });

  it("attaches more dispatches idempotently only within the task session", () => {
    const origin = dispatchFor(session, "原始");
    const attached = dispatchFor(session, "补充");
    const foreign = dispatchFor(other, "越权");
    const run = runStore.createRun({
      taskId: task.id,
      originDispatchId: origin.id,
      closureMode: "silent_ok",
      originKind: "dispatch",
    });
    expect(runStore.attachDispatch(run.id, attached.id, { relation: "attach" })).toBe(true);
    expect(runStore.attachDispatch(run.id, attached.id, { relation: "attach" })).toBe(false);
    expect(() => runStore.attachDispatch(run.id, foreign.id, { relation: "attach" })).toThrow(/跨会话/);
    expect(runStore.listDispatches(run.id).map((row) => row.dispatch_id)).toEqual([origin.id, attached.id]);
  });
});

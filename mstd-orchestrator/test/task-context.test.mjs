import { describe, it, expect, beforeEach } from "vitest";
import { openDb, migrate } from "../server/db/index.mjs";
import { createSessionStore } from "../server/sessions/store.mjs";
import { createReasoningTaskStore } from "../server/reasoning/task-store.mjs";
import { buildTaskContext, createTaskContextProvider } from "../server/reasoning/task-context.mjs";

describe("task-context", () => {
  let db, sessions, taskStore, session, other;

  beforeEach(() => {
    db = openDb();
    migrate(db);
    sessions = createSessionStore(db);
    taskStore = createReasoningTaskStore(db);
    session = sessions.getOrCreate("feishu:p2p:ou_a", { kind: "p2p" });
    other = sessions.getOrCreate("feishu:p2p:ou_b", { kind: "p2p" });
  });

  it("includes only linked messages, summary, memory, and tool results for the task", () => {
    const task = taskStore.createTask({
      sessionId: session.id,
      title: "查会议室",
      summary: "周五空档",
      closureMode: "silent_ok",
    });
    const linkedUser = sessions.append(session.id, { role: "user", content: "查一下周五会议室", ts: 1 });
    const linkedTool = sessions.append(session.id, { role: "tool", content: "room A free", ts: 2 });
    const unrelated = sessions.append(session.id, { role: "user", content: "另外说说午饭", ts: 3 });
    taskStore.attachMessage({ taskId: task.id, messageId: linkedUser.id, relation: "source" });
    taskStore.attachMessage({ taskId: task.id, messageId: linkedTool.id, relation: "tool_result" });

    const text = buildTaskContext({
      taskStore,
      taskId: task.id,
      snapshot: { org: "org-note", scoped: "scoped-note" },
    });
    expect(text).toContain("查会议室");
    expect(text).toContain("周五空档");
    expect(text).toContain("查一下周五会议室");
    expect(text).toContain("room A free");
    expect(text).toContain("org-note");
    expect(text).toContain("scoped-note");
    expect(text).not.toContain("另外说说午饭");
    expect(unrelated.id).toBeTruthy();
  });

  it("excludes unrelated session transcript lines via provider", () => {
    const taskA = taskStore.createTask({ sessionId: session.id, title: "A" });
    const taskB = taskStore.createTask({ sessionId: session.id, title: "B" });
    const mA = sessions.append(session.id, { role: "user", content: "只给 A", ts: 1 });
    const mB = sessions.append(session.id, { role: "user", content: "只给 B", ts: 2 });
    taskStore.attachMessage({ taskId: taskA.id, messageId: mA.id, relation: "source" });
    taskStore.attachMessage({ taskId: taskB.id, messageId: mB.id, relation: "source" });

    const provider = createTaskContextProvider({ taskStore });
    const ctxA = provider({ session, sessionKey: "feishu:p2p:ou_a", taskId: taskA.id });
    const ctxB = provider({ session, sessionKey: "feishu:p2p:ou_a", taskId: taskB.id });
    expect(ctxA).toContain("只给 A");
    expect(ctxA).not.toContain("只给 B");
    expect(ctxB).toContain("只给 B");
    expect(ctxB).not.toContain("只给 A");
    expect(other.id).toBeTruthy();
  });
});

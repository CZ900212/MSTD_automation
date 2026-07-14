import { describe, it, expect, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { openDb, migrate } from "../server/db/index.mjs";
import { createSessionStore } from "../server/sessions/store.mjs";
import {
  createReasoningTaskStore,
  outboundIdempotencyKey,
} from "../server/reasoning/task-store.mjs";

const MIGRATION = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), "../server/db/migrations/019_reasoning_tasks.sql"),
  "utf8",
);

describe("019_reasoning_tasks migration shape", () => {
  it("defines tasks, task_messages, dispatches with required columns and checks", () => {
    expect(MIGRATION).toMatch(/CREATE TABLE IF NOT EXISTS reasoning_tasks/);
    expect(MIGRATION).toMatch(/CREATE TABLE IF NOT EXISTS reasoning_task_messages/);
    expect(MIGRATION).toMatch(/CREATE TABLE IF NOT EXISTS reasoning_dispatches/);
    for (const col of [
      "session_id", "title", "summary", "status", "closure_mode", "created_at", "updated_at", "completed_at",
    ]) {
      expect(MIGRATION).toContain(col);
    }
    expect(MIGRATION).toMatch(/FOREIGN KEY|REFERENCES agent_sessions/);
    expect(MIGRATION).toMatch(/pending_send/);
    expect(MIGRATION).toMatch(/pending_review/);
    expect(MIGRATION).toMatch(/outbound_idempotency_key/);
    expect(MIGRATION).toMatch(/UNIQUE \(session_id, source_batch_key\)/);
    expect(MIGRATION).toMatch(/UNIQUE \(outbound_idempotency_key\)/);
  });

  it("applies via automatic migration discovery", () => {
    const db = openDb();
    migrate(db);
    const names = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((r) => r.name);
    expect(names).toEqual(expect.arrayContaining([
      "reasoning_tasks",
      "reasoning_task_messages",
      "reasoning_dispatches",
    ]));
    const applied = db.prepare("SELECT name FROM schema_migrations WHERE name = ?")
      .get("019_reasoning_tasks.sql");
    expect(applied).toBeTruthy();
    db.close();
  });
});

describe("createReasoningTaskStore", () => {
  let db, sessions, store, session, other;

  beforeEach(() => {
    db = openDb();
    migrate(db);
    sessions = createSessionStore(db);
    store = createReasoningTaskStore(db, { now: () => 10_000 });
    session = sessions.getOrCreate("feishu:p2p:ou_a", { kind: "p2p" });
    other = sessions.getOrCreate("feishu:p2p:ou_b", { kind: "p2p" });
  });

  function append(sessionId, content, role = "user") {
    return sessions.append(sessionId, { role, content, ts: Date.now() });
  }

  it("createDispatch is idempotent and issues stable outbound keys for reply", () => {
    const m1 = append(session.id, "hi");
    const m2 = append(session.id, "again");
    const a = store.createDispatch({
      sessionId: session.id,
      sourceMessageIds: [m2.id, m1.id],
      responderAction: "reply",
      responderText: "收到",
      mode: "p2p",
    });
    const b = store.createDispatch({
      sessionId: session.id,
      sourceMessageIds: [m1.id, m2.id],
      responderAction: "reply",
      responderText: "收到",
      mode: "p2p",
    });
    expect(b.id).toBe(a.id);
    expect(a.status).toBe("pending_send");
    expect(a.outbound_idempotency_key).toBe(outboundIdempotencyKey({
      sessionId: session.id,
      sourceBatchKey: a.source_batch_key,
      responderText: "收到",
    }));
    expect(a.outbound_idempotency_key).toHaveLength(64);
  });

  it("reply transitions pending_send -> pending_review -> running -> done; claim rejects pending_send", () => {
    const m = append(session.id, "查会议室");
    const d = store.createDispatch({
      sessionId: session.id,
      sourceMessageIds: [m.id],
      responderAction: "reply",
      responderText: "我去查",
      mode: "p2p",
    });
    expect(d.status).toBe("pending_send");
    expect(() => store.claimDispatchForReview(d.id)).toThrow(/pending_send/);

    const assistant = append(session.id, "我去查", "assistant");
    const reviewed = store.markDispatchSent(d.id, assistant.id);
    expect(reviewed.status).toBe("pending_review");
    expect(reviewed.responder_message_id).toBe(assistant.id);

    const running = store.claimDispatchForReview(d.id);
    expect(running.status).toBe("running");
    expect(running.attempts).toBe(1);

    const done = store.completeDispatch(d.id, {
      status: "done",
      verdict: { action: "spawn_new", reason_code: "needs_tools" },
    });
    expect(done.status).toBe("done");
    expect(JSON.parse(done.verdict_json).action).toBe("spawn_new");
  });

  it("atomically appends the responder message and advances pending_send", () => {
    const source = append(session.id, "查一下");
    const dispatch = store.createDispatch({
      sessionId: session.id,
      sourceMessageIds: [source.id],
      responderAction: "reply",
      responderText: "我去查",
      mode: "p2p",
    });

    expect(() => store.recordDispatchSent(dispatch.id, {
      platformMessageId: "om_atomic",
      appendAssistant: () => {
        sessions.append(session.id, {
          role: "assistant",
          content: "我去查",
          platformMessageId: "om_atomic",
          ts: 2,
        });
        throw new Error("crash before dispatch update");
      },
    })).toThrow(/crash/);
    expect(store.getDispatch(dispatch.id).status).toBe("pending_send");
    expect(sessions.transcript(session.id).filter((row) => row.role === "assistant")).toHaveLength(0);

    const committed = store.recordDispatchSent(dispatch.id, {
      platformMessageId: "om_atomic",
      appendAssistant: () => sessions.append(session.id, {
        role: "assistant",
        content: "我去查",
        platformMessageId: "om_atomic",
        ts: 2,
      }),
    });
    expect(committed.dispatch.status).toBe("pending_review");
    expect(committed.dispatch.responder_message_id).toBe(committed.assistant.id);
    expect(sessions.transcript(session.id).filter((row) => row.role === "assistant")).toHaveLength(1);

    const replay = store.recordDispatchSent(dispatch.id, {
      platformMessageId: "om_atomic",
      appendAssistant: () => { throw new Error("must reuse persisted assistant"); },
    });
    expect(replay.assistant.id).toBe(committed.assistant.id);
  });

  it("no_reply starts at pending_review without outbound key", () => {
    const m = append(session.id, "哈哈");
    const d = store.createDispatch({
      sessionId: session.id,
      sourceMessageIds: [m.id],
      responderAction: "no_reply",
      mode: "ambient",
    });
    expect(d.status).toBe("pending_review");
    expect(d.outbound_idempotency_key).toBeNull();
    expect(d.responder_text).toBeNull();
    const running = store.claimDispatchForReview(d.id);
    expect(running.status).toBe("running");
    expect(store.completeDispatch(d.id, { status: "failed" }).status).toBe("failed");
  });

  it("recovers pending_send delivery and stale running reviews after restart", () => {
    const m = append(session.id, "x");
    const d = store.createDispatch({
      sessionId: session.id,
      sourceMessageIds: [m.id],
      responderAction: "reply",
      responderText: "ok",
      mode: "p2p",
    });
    expect(store.listRetryableSends().map((r) => r.id)).toContain(d.id);

    const assistant = append(session.id, "ok", "assistant");
    store.markDispatchSent(d.id, assistant.id);
    store.claimDispatchForReview(d.id);

    // Simulate process age: force updated_at into the past.
    db.prepare("UPDATE reasoning_dispatches SET updated_at = 1 WHERE id = ?").run(d.id);
    const released = store.recoverStaleRunning({ olderThanMs: 1000 });
    expect(released).toBeGreaterThanOrEqual(1);
    expect(store.getDispatch(d.id).status).toBe("pending_review");
    expect(store.listReviewQueue().map((r) => r.id)).toContain(d.id);

    // Re-send path: same outbound key remains stable for idempotent delivery retry.
    const again = store.getDispatch(d.id);
    expect(store.getDispatchByOutboundKey(again.outbound_idempotency_key).id).toBe(d.id);
  });

  it("issues server-side task ids and refuses cross-session attach", () => {
    const task = store.createTask({
      sessionId: session.id,
      title: "查会议室",
      summary: "周五空档",
      closureMode: "silent_ok",
    });
    expect(task.id).toMatch(/[0-9a-f-]{36}/i);
    expect(task.status).toBe("active");

    const own = append(session.id, "补充：要大会议室");
    const foreign = append(other.id, "别的会话");
    expect(store.attachMessage({ taskId: task.id, messageId: own.id, relation: "steer" })).toBe(true);
    expect(() => store.attachMessage({ taskId: task.id, messageId: foreign.id, relation: "source" }))
      .toThrow(/跨会话/);
  });

  it("active summaries respect count and byte budgets", () => {
    for (let i = 0; i < 5; i++) {
      store.createTask({
        sessionId: session.id,
        title: `t${i}-${"x".repeat(40)}`,
        summary: "s".repeat(80),
      });
    }
    const limited = store.activeSummaries(session.id, { limit: 2, maxBytes: 10_000 });
    expect(limited).toHaveLength(2);
    const tiny = store.activeSummaries(session.id, { limit: 8, maxBytes: 120 });
    expect(tiny.length).toBeGreaterThanOrEqual(1);
    expect(tiny.length).toBeLessThanOrEqual(2);
    expect(tiny.every((t) => t.id && t.title && t.status === "active")).toBe(true);
  });

  it("supports active/completed/failed/cancelled transitions", () => {
    const task = store.createTask({ sessionId: session.id, title: "work", closureMode: "required" });
    expect(store.transitionTask(task.id, { status: "completed", summary: "done" }).status).toBe("completed");
    expect(store.getTask(task.id).completed_at).toBe(10_000);

    const t2 = store.createTask({ sessionId: session.id, title: "fail-me" });
    expect(store.transitionTask(t2.id, { status: "failed" }).status).toBe("failed");

    const t3 = store.createTask({ sessionId: session.id, title: "cancel-me" });
    expect(store.transitionTask(t3.id, { status: "cancelled" }).status).toBe("cancelled");

    const t4 = store.createTask({ sessionId: session.id, title: "still" });
    expect(store.transitionTask(t4.id, { status: "active", summary: "upd" }).summary).toBe("upd");
  });
});

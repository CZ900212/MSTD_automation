import { describe, it, expect, beforeEach, vi } from "vitest";
import { openDb, migrate } from "../server/db/index.mjs";
import { createModelLog } from "../server/models/model-log.mjs";

describe("model_log（模型链路可观测落库）", () => {
  let db, mlog;
  beforeEach(() => {
    db = openDb();
    migrate(db);
    mlog = createModelLog(db, { now: () => 5000 });
  });

  it("record 归一化各类事件为统一行；list 按时间倒序", () => {
    mlog.record({ type: "model_retry", chain: "fast", model: "v4-flash", attempt: 2, error: "HTTP 500" });
    mlog.record({ type: "model_fallback", chain: "fast", from: "v4-flash", to: "gpt-5.5", error: "HTTP 500" });
    mlog.record({ type: "pipeline_error", chain: "reason", error: "全链耗尽" });
    mlog.record({ type: "brain_fallback", sessionKey: "feishu:p2p:ou_x", from: "gpt-5.5", to: "v4-pro", phase: "turn", error: "timeout" });
    mlog.record({ type: "budget_exceeded", sessionKey: "feishu:p2p:ou_x", detail: "session" });
    mlog.record({ type: "outbound_retry", what: "发送", attempt: 1, error: "TLS timeout" });
    mlog.record({ type: "triage", sessionKey: "feishu:p2p:ou_x", action: "quick_reply", sourceAction: "quick_reply", provider: "v4-flash", guard: null, latencyMs: 123 });

    const rows = mlog.list();
    expect(rows).toHaveLength(7);
    // 全部同 ts，倒序容忍同刻；按 kind 找形状
    const byKind = Object.fromEntries(rows.map((r) => [r.kind, r]));
    expect(byKind.model_retry).toMatchObject({ chain: "fast", from_key: "v4-flash", attempt: 2, detail: "HTTP 500", ts: 5000 });
    expect(byKind.model_fallback).toMatchObject({ chain: "fast", from_key: "v4-flash", to_key: "gpt-5.5" });
    expect(byKind.pipeline_error).toMatchObject({ chain: "reason", detail: "全链耗尽" });
    expect(byKind.brain_fallback).toMatchObject({ session_key: "feishu:p2p:ou_x", from_key: "gpt-5.5", to_key: "v4-pro", detail: expect.stringContaining("timeout") });
    expect(byKind.budget_exceeded).toMatchObject({ session_key: "feishu:p2p:ou_x", detail: "session" });
    expect(byKind.outbound_retry).toMatchObject({ attempt: 1, detail: expect.stringContaining("发送") });
    expect(byKind.triage).toMatchObject({ session_key: "feishu:p2p:ou_x", detail: expect.stringContaining("action=quick_reply") });
    expect(byKind.triage.detail).toContain("provider=v4-flash");
    expect(byKind.triage.detail).toContain("latency_ms=123");
  });

  it("retains bounded turn outcome correlation without model content", () => {
    mlog.record({
      type: "brain_turn_outcome",
      sessionKey: "feishu:p2p:ou_x",
      turnId: "turn-123",
      purpose: "business",
      stage: "final",
      outcome: "rendered_reply",
      provider: "gpt-5.6-sol",
      replyCounts: { progress: 1, final: 1, safeFallback: 0, daemonFallback: 0 },
      brief: "must-not-log",
    });
    const [row] = mlog.list();
    expect(row.detail).toContain("turn_id=turn-123");
    expect(row.detail).toContain("purpose=business");
    expect(row.detail).toContain("outcome=rendered_reply");
    expect(row.detail).toContain("provider=gpt-5.6-sol");
    expect(row.detail).toContain("reply_counts=");
    expect(row.detail).not.toContain("must-not-log");
  });

  it("list 支持 kind 过滤与 limit", () => {
    for (let i = 0; i < 5; i++) mlog.record({ type: "model_retry", chain: "fast", model: "v4-flash", attempt: i + 1, error: "e" });
    mlog.record({ type: "pipeline_error", chain: "fast", error: "x" });
    expect(mlog.list({ kind: "model_retry" })).toHaveLength(5);
    expect(mlog.list({ kind: "model_retry", limit: 2 })).toHaveLength(2);
    expect(mlog.list({ kind: "pipeline_error" })).toHaveLength(1);
  });

  it("detail 超长截断（500 字符），错误对象也能收", () => {
    mlog.record({ type: "pipeline_error", chain: "fast", error: new Error("x".repeat(900)) });
    const [row] = mlog.list();
    expect(row.detail.length).toBeLessThanOrEqual(500);
  });

  it("record fail-safe：落库失败只打日志，绝不抛（可观测性不能反噬主链路）", () => {
    const log = vi.fn();
    const broken = createModelLog(db, { log });
    db.close();
    expect(() => broken.record({ type: "model_retry", chain: "fast", model: "m", attempt: 1, error: "e" })).not.toThrow();
    expect(log).toHaveBeenCalled();
  });

  it("records dispatcher lifecycle events with action/reason/latency", () => {
    mlog.record({
      type: "dispatcher_decision",
      sessionKey: "feishu:p2p:ou_x",
      chain: "dispatcher",
      action: "spawn_new",
      reason_code: "needs_tools",
      latencyMs: 42,
      provider: "v4-flash",
      taskId: "task-1",
      dispatchId: "disp-1",
    });
    mlog.record({
      type: "dispatcher_fallback",
      sessionKey: "feishu:p2p:ou_x",
      chain: "dispatcher",
      reason_code: "dispatcher_fallback_spawn",
      latencyMs: 9,
    });
    const rows = mlog.list();
    const decision = rows.find((r) => r.kind === "dispatcher_decision");
    const fallback = rows.find((r) => r.kind === "dispatcher_fallback");
    expect(decision).toMatchObject({
      session_key: "feishu:p2p:ou_x",
      chain: "dispatcher",
      task_id: "task-1",
      dispatch_id: "disp-1",
      decision: "spawn_new",
      reason_code: "needs_tools",
      latency_ms: 42,
    });
    expect(decision.detail).toContain("action=spawn_new");
    expect(decision.detail).toContain("reason_code=needs_tools");
    expect(decision.detail).toContain("latency_ms=42");
    expect(fallback.detail).toContain("reason_code=dispatcher_fallback_spawn");
    expect(mlog.list({ taskId: "task-1" })).toHaveLength(1);
    expect(mlog.list({ decision: "spawn_new" })).toHaveLength(1);
  });

  it("event sequence covers first reply, dispatch, task start, handoff", () => {
    for (const evt of [
      { type: "responder_sent", sessionKey: "s", action: "reply", dispatchId: "d1", latencyMs: 10 },
      { type: "dispatcher_decision", sessionKey: "s", action: "spawn_new", reason_code: "needs_tools", dispatchId: "d1", taskId: "t1" },
      { type: "task_created", sessionKey: "s", taskId: "t1" },
      { type: "reasoner_started", sessionKey: "s", taskId: "t1", runId: "r1" },
      { type: "handoff_sent", sessionKey: "s", taskId: "t1", runId: "r1" },
    ]) mlog.record(evt);
    const kinds = mlog.list({ taskId: "t1" }).map((r) => r.kind).reverse();
    // list is newest-first; reverse for chronological among filtered rows that have task_id
    expect(mlog.list().map((r) => r.kind)).toEqual(expect.arrayContaining([
      "responder_sent", "dispatcher_decision", "task_created", "reasoner_started", "handoff_sent",
    ]));
    expect(kinds).toEqual(expect.arrayContaining(["dispatcher_decision", "task_created", "reasoner_started", "handoff_sent"]));
  });
});

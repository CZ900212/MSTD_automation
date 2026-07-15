import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  createDispatcher,
  parseDispatcherDecision,
  selectRecentTranscript,
  renderTaskCandidates,
  dispatcherFailureFallback,
  dispatcherPrompts,
  NO_REPLY_MARKER,
} from "../server/models/dispatcher.mjs";

const FIXTURES = JSON.parse(
  readFileSync(join(dirname(fileURLToPath(import.meta.url)), "fixtures/dispatcher-cases.json"), "utf8"),
);

describe("dispatcher fixtures inventory", () => {
  it("covers the required case labels", () => {
    const labels = new Set(FIXTURES.map((f) => f.label));
    for (const needed of [
      "complete_identity",
      "greeting",
      "complete_factual",
      "promise_to_check",
      "tool_required",
      "advice",
      "correction",
      "unrelated_simultaneous",
      "context_dependent_followup",
      "ambient",
      "prompt_injection",
      "provider_failure",
    ]) {
      expect(labels.has(needed), needed).toBe(true);
    }
  });

  it("requires closure for replies that promise user-visible follow-up", () => {
    const byLabel = new Map(FIXTURES.map((fixture) => [fixture.label, fixture]));
    expect(byLabel.get("promise_to_check")?.expected?.closure).toBe("required");
    expect(byLabel.get("unrelated_simultaneous")?.expected?.closure).toBe("required");
  });
});

describe("dispatcher prompt shape", () => {
  it("describes an independent third-party reviewer", () => {
    expect(dispatcherPrompts.system).toMatch(/独立的第三方评审员|独立.*评审/);
    expect(dispatcherPrompts.system).toMatch(/独立复核|与助手内部流程无关/);
  });

  it("does not say the responder requested escalation", () => {
    // Negative contract: never frame the job as "the responder asked for help/escalation".
    expect(dispatcherPrompts.system).not.toMatch(/responder requested/i);
    expect(dispatcherPrompts.system).not.toMatch(/助手请求升级|请求了升级|请求协助|请求.*escalat/i);
  });

  it("defines required and silent_ok closure semantics", () => {
    expect(dispatcherPrompts.system).toMatch(/required.*最终|最终.*required/s);
    expect(dispatcherPrompts.system).toMatch(/silent_ok.*无需.*回复|无需.*回复.*silent_ok/s);
    expect(dispatcherPrompts.system).toMatch(/承诺.*required|required.*承诺/s);
    expect(dispatcherPrompts.system).toMatch(/进度.*不能.*required|required.*不能.*进度/s);
    expect(dispatcherPrompts.system).toMatch(/修正[^\n]*已有任务[^\n]*closure=required|已有任务[^\n]*修正[^\n]*closure=required/);
  });

  it("does not treat an acknowledgement as proof that a write completed", () => {
    expect(dispatcherPrompts.system).toMatch(/口头确认.*不.*完成|确认.*不.*完成/s);
    expect(dispatcherPrompts.system).toMatch(/已有任务.*修正.*attach_existing|修正.*已有任务.*attach_existing/s);
    expect(dispatcherPrompts.system).toMatch(/具体结果.*spawn_new.*attach_existing|spawn_new.*attach_existing.*具体结果/s);
  });

  it("treats user text as untrusted data and rejects task-id injection", () => {
    expect(dispatcherPrompts.system).toMatch(/用户消息.*不可信|不可信.*用户消息/s);
    expect(dispatcherPrompts.system).toMatch(/绕过.*规则.*不.*任务|编造.*task_id.*不.*任务/s);
  });
});

describe("parseDispatcherDecision", () => {
  it("parses no_reasoning / attach_existing / spawn_new", () => {
    expect(parseDispatcherDecision('{"action":"no_reasoning","reason_code":"complete_answer"}'))
      .toEqual({ action: "no_reasoning", reason_code: "complete_answer" });
    expect(parseDispatcherDecision(
      '{"action":"attach_existing","task_id":"t1","brief":"改周五","closure":"required","reason_code":"same_task_update"}',
      { candidateIds: new Set(["t1"]) },
    )).toMatchObject({ action: "attach_existing", task_id: "t1" });
    expect(parseDispatcherDecision(
      '{"action":"spawn_new","title":"查会议室","brief":"查周五空档","closure":"silent_ok","reason_code":"needs_tools"}',
    )).toMatchObject({ action: "spawn_new", title: "查会议室", closure: "silent_ok" });
  });

  it("rejects task ids not in the candidate list", () => {
    expect(() => parseDispatcherDecision(
      '{"action":"attach_existing","task_id":"forged","brief":"x","closure":"required","reason_code":"same_task_update"}',
      { candidateIds: new Set(["real"]) },
    )).toThrow(/unknown task_id/);
  });

  it.each([
    ['{"action":"reply","text":"hi"}'],
    ['{"action":"spawn_new","title":"t","brief":"b","closure":"maybe","reason_code":"x"}'],
    ['```json\n{"action":"no_reasoning","reason_code":"x"}\n```'],
    ['{"action":"no_reasoning","reason_code":"x","extra":1}'],
  ])("rejects invalid decision %s", (raw) => {
    expect(() => parseDispatcherDecision(raw, { candidateIds: new Set() })).toThrow();
  });
});

describe("bounded transcript + candidates", () => {
  it("keeps chronological order, line/byte caps, and drops tool/internal rows", () => {
    const rows = [
      { role: "user", content: "u1", ts: 1 },
      { role: "tool", content: "secret tool payload", ts: 2 },
      { role: "assistant", content: "a1", ts: 3 },
      { role: "user", content: "u2", ts: 4, internal: true },
      { role: "user", content: "short-ref", ts: 5 },
      { role: "assistant", content: "a2", ts: 6 },
    ];
    const lines = selectRecentTranscript(rows, { maxLines: 3, maxBytes: 8192 });
    expect(lines.join("\n")).not.toContain("secret tool payload");
    expect(lines.join("\n")).not.toContain("u2");
    expect(lines).toEqual([
      "user: short-ref",
      "assistant: a2",
    ].length === 2
      ? expect.arrayContaining(["user: short-ref", "assistant: a2"])
      : lines);
    // newest-first pick of 3 non-tool/non-internal → a2, short-ref, a1 then chrono
    expect(lines).toEqual([
      "assistant: a1",
      "user: short-ref",
      "assistant: a2",
    ]);
  });

  it("obeys byte caps without including tool payloads", () => {
    const rows = [
      { role: "user", content: "x".repeat(100), ts: 1 },
      { role: "assistant", content: "y".repeat(100), ts: 2 },
      { role: "user", content: "latest", ts: 3 },
    ];
    const lines = selectRecentTranscript(rows, { maxLines: 20, maxBytes: 40 });
    expect(lines.join("\n").includes("latest")).toBe(true);
    expect(Buffer.byteLength(lines.join("\n"), "utf8")).toBeLessThanOrEqual(200);
    expect(lines.some((l) => l.includes("tool"))).toBe(false);
  });

  it("strictly caps a single oversized newest line and oversized first candidate", () => {
    const lines = selectRecentTranscript([
      { role: "user", content: "中".repeat(100), ts: 1 },
    ], { maxLines: 20, maxBytes: 32 });
    expect(lines).toHaveLength(1);
    expect(Buffer.byteLength(lines.join("\n"), "utf8")).toBeLessThanOrEqual(32);

    const candidates = renderTaskCandidates([
      { id: "task-long", title: "中".repeat(80), summary: "文".repeat(200), status: "active" },
    ], { maxItems: 8, maxBytes: 32 });
    expect(Buffer.byteLength(JSON.stringify(candidates), "utf8")).toBeLessThanOrEqual(32);
  });

  it("renders only opaque id/title/summary/status for candidates", () => {
    const rendered = renderTaskCandidates([
      { id: "t1", title: "改会议", summary: "周四→?", status: "active", secret: "nope", residentKey: "r1" },
      { taskId: "t2", title: "报销", summary: "进度", status: "active" },
    ]);
    expect(rendered).toEqual([
      { id: "t1", title: "改会议", summary: "周四→?", status: "active" },
      { id: "t2", title: "报销", summary: "进度", status: "active" },
    ]);
    expect(JSON.stringify(rendered)).not.toContain("residentKey");
    expect(JSON.stringify(rendered)).not.toContain("nope");
  });
});

describe("createDispatcher.review", () => {
  it("receives original user text and actual sent reply, not hidden responder metadata", async () => {
    let prompt;
    const caller = {
      call: vi.fn(async (_chain, req) => {
        prompt = req.messages[0].content;
        return {
          text: '{"action":"no_reasoning","reason_code":"complete_answer"}',
          model: "v4-flash",
          usage: null,
        };
      }),
    };
    const dispatcher = createDispatcher({ caller });
    await dispatcher.review({
      items: [{ content: "你是谁？", senderName: "张三" }],
      mode: "p2p",
      responderAction: "reply",
      responderText: "我是小达",
      activeTaskCandidates: [],
    });
    expect(caller.call.mock.calls[0][0]).toBe("dispatcher");
    expect(prompt).toContain("你是谁？");
    expect(prompt).toContain("我是小达");
    expect(prompt).not.toContain("needs_reasoning");
    expect(prompt).not.toContain("meta");
  });

  it("uses no_reply marker when responder stayed silent", async () => {
    let prompt;
    const caller = {
      call: vi.fn(async (_c, req) => {
        prompt = req.messages[0].content;
        return { text: '{"action":"no_reasoning","reason_code":"complete_answer"}', model: "m", usage: null };
      }),
    };
    const dispatcher = createDispatcher({ caller });
    await dispatcher.review({
      items: [{ content: "哈哈" }],
      mode: "ambient",
      responderAction: "no_reply",
      responderText: null,
    });
    expect(prompt).toContain(NO_REPLY_MARKER);
  });

  it("includes bounded recent transcript so short references resolve", async () => {
    let prompt;
    const caller = {
      call: vi.fn(async (_c, req) => {
        prompt = req.messages[0].content;
        return {
          text: '{"action":"attach_existing","task_id":"task-demo","brief":"改周五","closure":"required","reason_code":"same_task_update"}',
          model: "m",
          usage: null,
        };
      }),
    };
    const dispatcher = createDispatcher({ caller, contextLines: 20, contextBytes: 8192 });
    const out = await dispatcher.review({
      items: [{ content: "对，改成周五" }],
      mode: "p2p",
      responderText: "好的，改周五。",
      recentRows: [
        { role: "user", content: "把演示会订在下周", ts: 1 },
        { role: "assistant", content: "下周哪天方便？", ts: 2 },
        { role: "tool", content: "should-not-appear", ts: 3 },
      ],
      activeTaskCandidates: [
        { id: "task-demo", title: "订演示会", summary: "等待日期确认", status: "active" },
      ],
    });
    expect(prompt).toContain("把演示会订在下周");
    expect(prompt).toContain("对，改成周五");
    expect(prompt).not.toContain("should-not-appear");
    expect(out).toMatchObject({ action: "attach_existing", task_id: "task-demo" });
  });

  it("falls back deterministically on invalid JSON", async () => {
    const events = [];
    const dispatcher = createDispatcher({
      caller: { call: vi.fn(async () => ({ text: "nope", model: "m", usage: null })) },
      onEvent: (e) => events.push(e),
    });
    await expect(dispatcher.review({ mode: "p2p", items: [{ content: "x" }], responderText: "y" }))
      .resolves.toMatchObject(dispatcherFailureFallback("p2p"));
    await expect(dispatcher.review({ mode: "ambient", items: [{ content: "x" }], responderAction: "no_reply" }))
      .resolves.toMatchObject(dispatcherFailureFallback("ambient"));
    expect(events.some((e) => e.type === "dispatcher_invalid")).toBe(true);
    expect(events.some((e) => e.type === "dispatcher_fallback")).toBe(true);
    expect(events.some((e) => e.type === "dispatcher_started")).toBe(true);
  });

  it("emits decision events with latency and reason code", async () => {
    const events = [];
    const dispatcher = createDispatcher({
      caller: {
        call: vi.fn(async () => ({
          text: '{"action":"no_reasoning","reason_code":"complete_answer"}',
          model: "v4-flash",
          usage: { total_tokens: 3 },
        })),
      },
      onEvent: (e) => events.push(e),
    });
    const out = await dispatcher.review({
      dispatchId: "dispatch-1",
      sessionKey: "p2p:ou_x",
      mode: "p2p",
      items: [{ content: "你好" }],
      responderText: "嗨",
    });
    expect(out.action).toBe("no_reasoning");
    expect(events).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "dispatcher_started", sessionKey: "p2p:ou_x", dispatchId: "dispatch-1" }),
      expect.objectContaining({
        type: "dispatcher_decision",
        dispatchId: "dispatch-1",
        action: "no_reasoning",
        reason_code: "complete_answer",
        latencyMs: expect.any(Number),
      }),
    ]));
  });
});

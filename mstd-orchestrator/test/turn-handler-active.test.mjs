import { describe, it, expect, vi } from "vitest";
import { openDb, migrate } from "../server/db/index.mjs";
import { createSessionStore } from "../server/sessions/store.mjs";
import { createReasoningTaskStore } from "../server/reasoning/task-store.mjs";
import { createTurnHandler } from "../server/gateway/turn-handler.mjs";

describe("turn-handler active architecture", () => {
  it("uses the per-turn resolved architecture mode over the constructor default", async () => {
    const db = openDb();
    migrate(db);
    const store = createSessionStore(db);
    const sessionKey = "feishu:p2p:ou_resolved";
    const session = store.getOrCreate(sessionKey, { kind: "p2p" });
    const responder = { answerTurn: vi.fn(async () => ({ action: "reply", text: "active reply" })) };
    const taskStore = {
      createDispatch: vi.fn(() => ({ id: "d1", outbound_idempotency_key: "k1" })),
      recordDispatchSent: vi.fn(),
    };
    const coordinator = { schedule: vi.fn() };
    const handler = createTurnHandler({
      architectureMode: "legacy",
      triage: { triage: vi.fn(async () => ({ action: "no_reply" })) },
      brain: { turn: vi.fn(), steer: vi.fn(), isBusy: vi.fn() },
      store,
      budget: { allow: () => ({ ok: true }), record: vi.fn() },
      responder,
      taskStore,
      coordinator,
      replyPipeline: {
        deliverText: vi.fn(async () => ({ messageId: "om1" })),
        deliverTerminal: vi.fn(), handleReply: vi.fn(), renderAutomationReply: vi.fn(), deliverTrusted: vi.fn(),
      },
    });
    await handler.handleTurn({
      kind: "message", session, sessionKey, items: [{ content: "x", ts: 1 }], mode: "p2p",
      architectureMode: "active",
    });
    expect(responder.answerTurn).toHaveBeenCalled();
    expect(coordinator.schedule).toHaveBeenCalled();
  });
  it("shadow preserves legacy outbound while reviewing responder and dispatcher without task side effects", async () => {
    const db = openDb();
    migrate(db);
    const store = createSessionStore(db);
    const taskStore = createReasoningTaskStore(db);
    const sessionKey = "feishu:p2p:ou_shadow";
    const session = store.getOrCreate(sessionKey, { kind: "p2p" });
    const deliverText = vi.fn(async () => ({ messageId: "om_legacy" }));
    const dispatcher = {
      review: vi.fn(async () => ({ action: "no_reasoning", reason_code: "complete" })),
    };
    const responder = {
      answerTurn: vi.fn(async () => ({ action: "reply", text: "影子首答候选" })),
    };
    const brain = { turn: vi.fn(), isBusy: () => false, steer: vi.fn(), recycle: vi.fn() };
    const handler = createTurnHandler({
      architectureMode: "shadow",
      triage: { triage: vi.fn(async () => ({ action: "quick_reply", text: "现网正式回复" })) },
      brain,
      responder,
      dispatcher,
      taskStore,
      coordinator: { schedule: vi.fn() },
      store,
      budget: { allow: () => ({ ok: true }), record: vi.fn() },
      replyPipeline: {
        deliverText,
        deliverTerminal: vi.fn(),
        handleReply: vi.fn(),
        renderAutomationReply: vi.fn(),
        deliverTrusted: vi.fn(),
      },
    });
    const items = [{ content: "你是谁？", senderOpenId: "ou_shadow", ts: 1 }];

    await handler.handleTurn({ kind: "message", session, sessionKey, mode: "p2p", items });

    expect(deliverText).toHaveBeenCalledWith(sessionKey, "现网正式回复");
    expect(store.transcript(session.id).map((row) => [row.role, row.content])).toEqual([
      ["user", "你是谁？"],
      ["assistant", "现网正式回复"],
    ]);
    await vi.waitFor(() => expect(dispatcher.review).toHaveBeenCalledTimes(1));
    expect(dispatcher.review).toHaveBeenCalledWith(expect.objectContaining({
      sessionKey,
      items,
      mode: "p2p",
      responderAction: "reply",
      responderText: "影子首答候选",
    }));
    expect(db.prepare("SELECT COUNT(*) AS n FROM reasoning_dispatches").get().n).toBe(0);
    expect(db.prepare("SELECT COUNT(*) AS n FROM reasoning_tasks").get().n).toBe(0);
    expect(brain.turn).not.toHaveBeenCalled();
  });

  it("persists pending_send before physical send and schedules review without waiting on reasoner", async () => {
    const db = openDb();
    migrate(db);
    const store = createSessionStore(db);
    const taskStore = createReasoningTaskStore(db);
    const session = store.getOrCreate("feishu:p2p:ou_a", { kind: "p2p" });
    const order = [];
    const brainBusy = vi.fn(async () => {
      order.push("reasoner");
      await new Promise(() => {}); // never settles
    });
    const outboundCalls = [];
    const deliverText = vi.fn(async (sessionKey, text, opts = {}) => {
      order.push("send");
      outboundCalls.push({ sessionKey, text, opts });
      return { messageId: "om_1" };
    });
    const coordinator = {
      schedule: vi.fn((args) => {
        order.push("schedule");
        return Promise.resolve();
      }),
    };
    const responder = {
      answerTurn: vi.fn(async () => {
        order.push("responder");
        return { action: "reply", text: "先回你一句" };
      }),
    };
    const origCreate = taskStore.createDispatch.bind(taskStore);
    taskStore.createDispatch = (args) => {
      order.push("pending_send");
      return origCreate(args);
    };
    const origRecordSent = taskStore.recordDispatchSent.bind(taskStore);
    taskStore.recordDispatchSent = (dispatchId, options) => {
      order.push("commit_send");
      return origRecordSent(dispatchId, options);
    };
    taskStore.markDispatchSent = () => { throw new Error("active path must use atomic recordDispatchSent"); };
    const handler = createTurnHandler({
      architectureMode: "active",
      triage: { triage: vi.fn() },
      brain: { turn: brainBusy, isBusy: () => true, steer: vi.fn(), recycle: vi.fn() },
      responder,
      taskStore,
      coordinator,
      store,
      budget: { allow: () => ({ ok: true }), record: vi.fn() },
      replyPipeline: {
        deliverText,
        deliverTerminal: vi.fn(),
        handleReply: vi.fn(),
        renderAutomationReply: vi.fn(),
        deliverTrusted: vi.fn(),
      },
    });

    const done = await handler.handleTurn({
      kind: "message",
      session,
      sessionKey: "feishu:p2p:ou_a",
      mode: "p2p",
      items: [{ content: "帮我查一下", senderOpenId: "ou_a", ts: Date.now() }],
    });

    expect(done.action).toBe("reply");
    expect(order.indexOf("pending_send")).toBeLessThan(order.indexOf("send"));
    expect(order.indexOf("send")).toBeLessThan(order.indexOf("commit_send"));
    expect(order.indexOf("commit_send")).toBeLessThan(order.indexOf("schedule"));
    expect(order).not.toContain("reasoner");
    expect(coordinator.schedule).toHaveBeenCalled();
    expect(outboundCalls[0].opts.idempotencyKey).toMatch(/^[a-f0-9]{32}$/);
  });

  it("reaches responder while a task reasoner remains blocked", async () => {
    const db = openDb();
    migrate(db);
    const store = createSessionStore(db);
    const taskStore = createReasoningTaskStore(db);
    const session = store.getOrCreate("feishu:p2p:ou_a", { kind: "p2p" });
    let reasonerStarted = false;
    const brain = {
      isBusy: () => reasonerStarted,
      turn: vi.fn(async () => {
        reasonerStarted = true;
        await new Promise(() => {});
      }),
      steer: vi.fn(),
      recycle: vi.fn(),
    };
    const handler = createTurnHandler({
      architectureMode: "active",
      triage: { triage: vi.fn() },
      brain,
      responder: { answerTurn: vi.fn(async () => ({ action: "reply", text: "第二句也先回" })) },
      taskStore,
      coordinator: { schedule: vi.fn(() => Promise.resolve()) },
      store,
      budget: { allow: () => ({ ok: true }), record: vi.fn() },
      replyPipeline: {
        deliverText: vi.fn(async () => ({ messageId: "om_2" })),
        deliverTerminal: vi.fn(),
        handleReply: vi.fn(),
        renderAutomationReply: vi.fn(),
        deliverTrusted: vi.fn(),
      },
    });
    // Simulate task A already running (busy flag true); new message still answers via responder.
    reasonerStarted = true;
    const out = await handler.handleTurn({
      kind: "message",
      session,
      sessionKey: "feishu:p2p:ou_a",
      mode: "p2p",
      items: [{ content: "还有一件事", senderOpenId: "ou_a", ts: Date.now() }],
    });
    expect(out.action).toBe("reply");
    expect(out.messageId).toBe("om_2");
  });

  it("gives the responder bounded conversation preceding the current batch", async () => {
    const db = openDb();
    migrate(db);
    const store = createSessionStore(db);
    const taskStore = createReasoningTaskStore(db);
    const sessionKey = "feishu:p2p:ou_context";
    const session = store.getOrCreate(sessionKey, { kind: "p2p" });
    store.append(session.id, { role: "user", senderName: "甲", content: "会议原定周三", ts: 1 });
    store.append(session.id, { role: "assistant", content: "记下了", ts: 2 });
    const responder = { answerTurn: vi.fn(async () => ({ action: "reply", text: "已改周五" })) };
    const handler = createTurnHandler({
      architectureMode: "active",
      triage: { triage: vi.fn() },
      brain: { turn: vi.fn(), isBusy: () => false, steer: vi.fn(), recycle: vi.fn() },
      responder,
      taskStore,
      coordinator: { schedule: vi.fn() },
      store,
      budget: { allow: () => ({ ok: true }), record: vi.fn() },
      replyPipeline: {
        deliverText: vi.fn(async () => ({ messageId: "om_context" })),
        deliverTerminal: vi.fn(),
        handleReply: vi.fn(),
        renderAutomationReply: vi.fn(),
        deliverTrusted: vi.fn(),
      },
    });

    await handler.handleTurn({
      kind: "message",
      session,
      sessionKey,
      mode: "p2p",
      items: [{ content: "对，改成周五", senderOpenId: "ou_context", ts: 3 }],
    });

    expect(responder.answerTurn).toHaveBeenCalledWith(expect.objectContaining({
      recentConversation: expect.stringContaining("会议原定周三"),
    }));
    expect(responder.answerTurn.mock.calls[0][0].recentConversation).not.toContain("对，改成周五");
  });

  it("fills responder history by token budget beyond the former 20-row cap", async () => {
    const db = openDb();
    migrate(db);
    const store = createSessionStore(db);
    const taskStore = createReasoningTaskStore(db);
    const sessionKey = "feishu:group:oc_history_budget";
    const session = store.getOrCreate(sessionKey, { kind: "group", chatId: "oc_history_budget" });
    for (let i = 1; i <= 30; i++) {
      store.append(session.id, { role: "user", senderName: `成员${i}`, content: `历史消息${i}`, ts: i });
    }
    const events = [];
    const responder = { answerTurn: vi.fn(async () => ({ action: "no_reply", meta: { reasonCode: "human_conversation" } })) };
    const handler = createTurnHandler({
      architectureMode: "active",
      triage: { triage: vi.fn() },
      brain: { turn: vi.fn(), isBusy: () => false, steer: vi.fn(), recycle: vi.fn() },
      responder,
      taskStore,
      coordinator: { schedule: vi.fn() },
      store,
      budget: { allow: () => ({ ok: true }), record: vi.fn() },
      onEvent: (event) => events.push(event),
      replyPipeline: {
        deliverText: vi.fn(), deliverTerminal: vi.fn(), handleReply: vi.fn(),
        renderAutomationReply: vi.fn(), deliverTrusted: vi.fn(),
      },
    });

    await handler.handleTurn({
      kind: "message",
      session,
      sessionKey,
      mode: "ambient",
      items: [{ content: "当前消息", senderName: "成员30", ts: 31 }],
    });

    const recent = responder.answerTurn.mock.calls[0][0].recentConversation;
    expect(recent).toContain("历史消息1");
    expect(recent).toContain("历史消息30");
    expect(recent).not.toContain("当前消息");
    expect(recent.split("\n")).toHaveLength(30);
    expect(events).toContainEqual(expect.objectContaining({
      type: "responder_sent",
      action: "no_reply",
      reason_code: "human_conversation",
    }));
  });

  it("binds a delayed message to the id returned by append instead of an older high-ts row", async () => {
    const db = openDb();
    migrate(db);
    const store = createSessionStore(db);
    const taskStore = createReasoningTaskStore(db);
    const sessionKey = "feishu:group:oc_delay";
    const session = store.getOrCreate(sessionKey, { kind: "group", chatId: "oc_delay" });
    const old = store.append(session.id, { role: "user", senderOpenId: "ou_old", content: "later timestamp", ts: 200 });
    const handler = createTurnHandler({
      architectureMode: "active",
      triage: { triage: vi.fn() },
      brain: { turn: vi.fn(), isBusy: () => false, steer: vi.fn(), recycle: vi.fn() },
      responder: { answerTurn: vi.fn(async () => ({ action: "no_reply" })) },
      taskStore,
      coordinator: { schedule: vi.fn() },
      store,
      budget: { allow: () => ({ ok: true }), record: vi.fn() },
      replyPipeline: {
        deliverText: vi.fn(), deliverTerminal: vi.fn(), handleReply: vi.fn(),
        renderAutomationReply: vi.fn(), deliverTrusted: vi.fn(),
      },
    });
    const out = await handler.handleTurn({
      kind: "message", session, sessionKey, mode: "ambient",
      items: [{ content: "delayed", senderOpenId: "ou_delayed", ts: 100 }],
    });
    const dispatch = taskStore.getDispatch(out.dispatchId);
    const [sourceId] = JSON.parse(dispatch.source_message_ids_json);
    const source = db.prepare("SELECT * FROM agent_messages WHERE id = ?").get(sourceId);
    expect(source.id).not.toBe(old.id);
    expect(source.sender_open_id).toBe("ou_delayed");
    expect(source.content).toBe("delayed");
  });
});

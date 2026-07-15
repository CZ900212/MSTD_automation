import { beforeEach, describe, expect, it, vi } from "vitest";
import { openDb, migrate } from "../server/db/index.mjs";
import { createSessionStore } from "../server/sessions/store.mjs";
import { createActiveTurnRegistry } from "../server/sessions/active-turn.mjs";
import {
  createTurnHandler,
  DAEMON_TERMINAL_FALLBACK,
} from "../server/gateway/turn-handler.mjs";
import { SAFE_REPLY_FALLBACK } from "../server/safety/reply-egress.mjs";

const items = [{
  content: "帮我查一下",
  senderOpenId: "ou_a",
  senderName: "张三",
  ts: 1000,
}];

describe("foreground business turn terminal receipt", () => {
  let store;
  let session;
  let deps;
  let handler;
  let events;
  let runActive;

  beforeEach(() => {
    const db = openDb();
    migrate(db);
    store = createSessionStore(db);
    session = store.getOrCreate("feishu:p2p:ou_a", { kind: "p2p" });
    events = [];
    let turnNo = 0;
    const activeTurnRegistry = createActiveTurnRegistry({
      issueId: () => `turn-${++turnNo}`,
    });
    deps = {
      triage: { triage: vi.fn(async () => ({ action: "escalate", brief: "查资料" })) },
      brain: {
        turn: vi.fn(async () => ({ finalText: "模型裸结论", events: [] })),
        steer: vi.fn(),
        isBusy: () => false,
      },
      renderReply: vi.fn(async () => ({ text: "正式答复", usage: null })),
      outbound: {
        sendMessage: vi.fn(async () => ({ messageId: `om_${deps.outbound.sendMessage.mock.calls.length}` })),
        sendCard: vi.fn(async () => ({ messageId: "om_card" })),
      },
      store,
      budget: { allow: () => ({ ok: true }), record: vi.fn() },
      activeTurns: activeTurnRegistry.receipts,
      activeBrainTurns: activeTurnRegistry.brainTurns,
      onEvent: (event) => events.push(event),
      log: vi.fn(),
    };
    runActive = async (args, callback) => {
      const lease = deps.activeBrainTurns.activate(args);
      deps.activeBrainTurns.bindResident(args.sessionKey, lease, 1);
      try {
        const result = await callback({ turnId: args.turnId, turnLease: lease, residentEpoch: 1 });
        const closing = await deps.activeBrainTurns.closeAdmissions(args.sessionKey, lease, { provider: "gpt-5.6-sol" });
        return {
          ...result,
          turnLifecycle: { turnId: args.turnId, sessionKey: args.sessionKey, purpose: args.purpose, lease, provider: "gpt-5.6-sol", closing },
        };
      } catch (error) {
        const closing = await deps.activeBrainTurns.closeAdmissions(args.sessionKey, lease, { provider: "gpt-5.6-sol" });
        error.turnLifecycle = { turnId: args.turnId, sessionKey: args.sessionKey, purpose: args.purpose, lease, provider: "gpt-5.6-sol", closing };
        throw error;
      }
    };
    deps.brain.turn.mockImplementation((args) => runActive(
      args,
      async () => ({ finalText: "模型裸结论", events: [] }),
    ));
    handler = createTurnHandler(deps);
  });

  it("normal brain completion without reply sends one fixed daemon fallback; ACK remains non-terminal", async () => {
    deps.triage.triage.mockResolvedValue({ action: "escalate", brief: "查资料", ack: "收到，我看看" });
    const result = await handler.handleTurn({
      kind: "message", session, sessionKey: "feishu:p2p:ou_a", items, mode: "addressed", initiatorOpenId: "ou_a",
    });

    expect(deps.brain.turn).toHaveBeenCalledWith(expect.objectContaining({
      turnId: "turn-1",
      purpose: "business",
      brief: "查资料",
    }));
    const sent = deps.outbound.sendMessage.mock.calls.map(([arg]) => arg.text);
    expect(sent).toEqual(["收到，我看看", DAEMON_TERMINAL_FALLBACK]);
    expect(sent).not.toContain("模型裸结论");
    expect(result.receipt).toMatchObject({
      turnId: "turn-1",
      state: "terminal",
      terminal: { outcome: "daemon_fallback_sent" },
      ack: { messageId: expect.any(String) },
    });
    expect(events).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "business_turn_admitted", turnId: "turn-1" }),
      expect.objectContaining({ type: "business_turn_ack", turnId: "turn-1", terminal: false }),
      expect.objectContaining({
        type: "business_turn_terminal",
        fallback_kind: "daemon_terminal",
        turnId: "turn-1",
        outcome: "daemon_fallback_sent",
      }),
      expect.objectContaining({
        type: "brain_turn_outcome",
        turnId: "turn-1",
        outcome: "daemon_terminal_fallback",
        replyCounts: { progress: 0, final: 0, safeFallback: 0, daemonFallback: 1 },
      }),
    ]));
  });

  it("formal reply receipt prevents daemon fallback and card_copy does not", async () => {
    deps.brain.turn.mockImplementationOnce((args) => runActive(args, async (turnContext) => {
      const reply = await handler.handleReply({
        sessionKey: "feishu:p2p:ou_a",
        kind: "message",
        brief: "给用户答复",
        ...turnContext,
      });
      expect(reply.ok).toBe(true);
      return { finalText: "内部完成", events: [] };
    }));
    const formal = await handler.handleTurn({
      kind: "message", session, sessionKey: "feishu:p2p:ou_a", items, mode: "addressed",
    });
    expect(deps.outbound.sendMessage).toHaveBeenCalledTimes(1);
    expect(deps.outbound.sendMessage).toHaveBeenCalledWith(expect.objectContaining({ text: "正式答复" }));
    expect(formal.receipt.terminal.outcome).toBe("formal_reply_sent");
    expect(events).toContainEqual(expect.objectContaining({
      type: "business_turn_terminal", turnId: "turn-1", outcome: "formal_reply_sent",
    }));

    deps.outbound.sendMessage.mockClear();
    deps.brain.turn.mockImplementationOnce((args) => runActive(args, async (turnContext) => {
      const copy = await handler.handleReply({
        sessionKey: "feishu:p2p:ou_a",
        kind: "card_copy",
        brief: "卡片文案",
        ...turnContext,
      });
      expect(copy.ok).toBe(true);
      return { finalText: "只有卡片文案", events: [] };
    }));
    const cardOnly = await handler.handleTurn({
      kind: "message", session, sessionKey: "feishu:p2p:ou_a", items, mode: "addressed",
    });
    expect(deps.outbound.sendMessage).toHaveBeenCalledTimes(1);
    expect(deps.outbound.sendMessage).toHaveBeenCalledWith(expect.objectContaining({ text: DAEMON_TERMINAL_FALLBACK }));
    expect(cardOnly.receipt.terminal.outcome).toBe("daemon_fallback_sent");
  });

  it("progress-only message is user-visible but remains non-terminal, so daemon sends final fallback", async () => {
    deps.brain.turn.mockImplementationOnce((args) => runActive(args, async (turnContext) => {
      const reply = await handler.handleReply({
        sessionKey: "feishu:p2p:ou_a",
        kind: "message",
        stage: "progress",
        brief: "还在查",
        ...turnContext,
      });
      expect(reply.ok).toBe(true);
      return { finalText: "内部完成", events: [] };
    }));

    const result = await handler.handleTurn({
      kind: "message", session, sessionKey: "feishu:p2p:ou_a", items, mode: "addressed",
    });
    expect(deps.outbound.sendMessage.mock.calls.map(([arg]) => arg.text))
      .toEqual(["正式答复", DAEMON_TERMINAL_FALLBACK]);
    expect(result.receipt.terminal.outcome).toBe("daemon_fallback_sent");
    expect(events).toContainEqual(expect.objectContaining({
      type: "brain_turn_outcome",
      outcome: "daemon_terminal_fallback",
      replyCounts: { progress: 1, final: 0, safeFallback: 0, daemonFallback: 1 },
    }));
  });

  it("brain completion drains an already-admitted final send before deciding fallback", async () => {
    let resolveSend;
    deps.outbound.sendMessage.mockImplementationOnce(() => new Promise((resolve) => { resolveSend = resolve; }));
    deps.brain.turn.mockImplementationOnce(async (args) => {
      const lease = deps.activeBrainTurns.activate(args);
      deps.activeBrainTurns.bindResident(args.sessionKey, lease, 1);
      const pendingReply = handler.handleReply({
        sessionKey: args.sessionKey,
        kind: "message",
        stage: "final",
        brief: "最终答案",
        turnId: args.turnId,
        turnLease: lease,
        residentEpoch: 1,
      });
      await vi.waitFor(() => expect(deps.outbound.sendMessage).toHaveBeenCalledTimes(1));
      const closing = await deps.activeBrainTurns.closeAdmissions(args.sessionKey, lease, { provider: "gpt-5.6-sol" });
      return {
        finalText: "内部",
        events: [],
        pendingReply,
        turnLifecycle: { turnId: args.turnId, sessionKey: args.sessionKey, purpose: args.purpose, lease, provider: "gpt-5.6-sol", closing },
      };
    });

    const turnPromise = handler.handleTurn({
      kind: "message", session, sessionKey: "feishu:p2p:ou_a", items, mode: "addressed",
    });
    await vi.waitFor(() => expect(deps.outbound.sendMessage).toHaveBeenCalledTimes(1));
    resolveSend({ messageId: "om_final" });
    const result = await turnPromise;
    expect(deps.outbound.sendMessage).toHaveBeenCalledTimes(1);
    expect(result.receipt.terminal.outcome).toBe("formal_reply_sent");
  });

  it("physical send failure does not fabricate a final receipt", async () => {
    deps.outbound.sendMessage
      .mockRejectedValueOnce(new Error("physical send failed"))
      .mockResolvedValueOnce({ messageId: "om_fallback" });
    deps.brain.turn.mockImplementationOnce((args) => runActive(args, async (turnContext) => {
      await expect(handler.handleReply({
        sessionKey: args.sessionKey,
        kind: "message",
        stage: "final",
        brief: "最终答案",
        ...turnContext,
      })).rejects.toThrow("physical send failed");
      return { finalText: "内部", events: [] };
    }));

    const result = await handler.handleTurn({
      kind: "message", session, sessionKey: "feishu:p2p:ou_a", items, mode: "addressed",
    });
    expect(deps.outbound.sendMessage).toHaveBeenCalledTimes(2);
    expect(result.receipt.terminal.outcome).toBe("daemon_fallback_sent");
    expect(events).toContainEqual(expect.objectContaining({
      type: "brain_turn_outcome",
      outcome: "daemon_terminal_fallback",
      replyCounts: { progress: 0, final: 0, safeFallback: 0, daemonFallback: 1 },
    }));
  });

  it("successful final delivery stays terminal when transcript append fails, so no duplicate fallback is sent", async () => {
    const originalAppend = store.append.bind(store);
    let failAssistant = true;
    store.append = vi.fn((sessionId, message) => {
      if (message.role === "assistant" && message.content === "正式答复" && failAssistant) {
        failAssistant = false;
        throw new Error("transcript write failed");
      }
      return originalAppend(sessionId, message);
    });
    deps.brain.turn.mockImplementationOnce((args) => runActive(args, async (turnContext) => {
      const reply = await handler.handleReply({
        sessionKey: args.sessionKey,
        kind: "message",
        stage: "final",
        brief: "最终答案",
        ...turnContext,
      });
      expect(reply.ok).toBe(true);
      return { finalText: "内部", events: [] };
    }));

    const result = await handler.handleTurn({
      kind: "message", session, sessionKey: "feishu:p2p:ou_a", items, mode: "addressed",
    });

    expect(deps.outbound.sendMessage).toHaveBeenCalledTimes(1);
    expect(deps.outbound.sendMessage).toHaveBeenCalledWith(expect.objectContaining({ text: "正式答复" }));
    expect(result.receipt.terminal.outcome).toBe("formal_reply_sent");
    expect(events).toContainEqual(expect.objectContaining({
      type: "delivered_transcript_append_failed",
      source: "formal_reply_sent",
      messageId: expect.any(String),
    }));
  });

  it("daemon fallback delivery failure releases the business-turn slot instead of wedging the session", async () => {
    deps.outbound.sendMessage.mockRejectedValue(new Error("fallback unavailable"));

    // 双重发送失败不再向上抛（没有重试消费者）：记录事件并释放槽位，会话不许被永久卡死
    await handler.handleTurn({
      kind: "message", session, sessionKey: "feishu:p2p:ou_a", items, mode: "addressed",
    });

    expect(deps.outbound.sendMessage).toHaveBeenCalledTimes(2);
    expect(events).toContainEqual(expect.objectContaining({
      type: "business_turn_terminalize_failed", sessionKey: "feishu:p2p:ou_a", turnId: "turn-1",
    }));
    expect(events).toContainEqual(expect.objectContaining({
      type: "business_turn_abandoned", sessionKey: "feishu:p2p:ou_a", turnId: "turn-1",
    }));
    expect(deps.activeTurns.resolve("feishu:p2p:ou_a")).toBe(null);
  });

  it("plain multiline final uses one atomic card, so card failure falls back without partial formal text", async () => {
    deps.renderReply.mockResolvedValue({ text: "第一段\n\n第二段", usage: null });
    deps.outbound.sendCard.mockRejectedValueOnce(new Error("card failed"));
    deps.outbound.sendMessage.mockResolvedValueOnce({ messageId: "om_fallback" });
    deps.brain.turn.mockImplementationOnce((args) => runActive(args, async (turnContext) => {
      await expect(handler.handleReply({
        sessionKey: args.sessionKey,
        kind: "message",
        stage: "final",
        brief: "最终答案",
        ...turnContext,
      })).rejects.toThrow("card failed");
      return { finalText: "内部", events: [] };
    }));

    const result = await handler.handleTurn({
      kind: "message", session, sessionKey: "feishu:p2p:ou_a", items, mode: "addressed",
    });

    expect(deps.outbound.sendCard).toHaveBeenCalledTimes(1);
    expect(deps.outbound.sendCard).toHaveBeenCalledWith(expect.objectContaining({
      cardJson: expect.objectContaining({ body: expect.any(Object) }),
    }));
    expect(deps.outbound.sendMessage.mock.calls.map(([arg]) => arg.text)).toEqual([DAEMON_TERMINAL_FALLBACK]);
    expect(result.receipt.terminal.outcome).toBe("daemon_fallback_sent");
  });

  it("two concurrent final replies reserve one terminal send and physically deliver only once", async () => {
    deps.brain.turn.mockImplementationOnce((args) => runActive(args, async (turnContext) => {
      const [one, two] = await Promise.all([
        handler.handleReply({ sessionKey: args.sessionKey, kind: "message", stage: "final", brief: "答案一", ...turnContext }),
        handler.handleReply({ sessionKey: args.sessionKey, kind: "message", stage: "final", brief: "答案二", ...turnContext }),
      ]);
      expect([one.ok, two.ok].sort()).toEqual([false, true]);
      return { finalText: "内部", events: [] };
    }));

    const result = await handler.handleTurn({
      kind: "message", session, sessionKey: "feishu:p2p:ou_a", items, mode: "addressed",
    });

    expect(deps.outbound.sendMessage).toHaveBeenCalledTimes(1);
    expect(result.receipt.terminal.outcome).toBe("formal_reply_sent");
  });

  it("rich Markdown card physical failure records no final receipt and falls back once", async () => {
    deps.renderReply.mockResolvedValue({ text: "## 最终答案", usage: null });
    deps.outbound.sendCard.mockRejectedValueOnce(new Error("card send failed"));
    deps.outbound.sendMessage.mockResolvedValueOnce({ messageId: "om_fallback" });
    deps.brain.turn.mockImplementationOnce((args) => runActive(args, async (turnContext) => {
      await expect(handler.handleReply({
        sessionKey: args.sessionKey,
        kind: "message",
        stage: "final",
        brief: "最终答案",
        ...turnContext,
      })).rejects.toThrow("card send failed");
      return { finalText: "内部", events: [] };
    }));

    const result = await handler.handleTurn({
      kind: "message", session, sessionKey: "feishu:p2p:ou_a", items, mode: "addressed",
    });

    expect(deps.outbound.sendCard).toHaveBeenCalledTimes(1);
    expect(deps.outbound.sendMessage).toHaveBeenCalledTimes(1);
    expect(result.receipt.terminal.outcome).toBe("daemon_fallback_sent");
    expect(events).toContainEqual(expect.objectContaining({
      type: "brain_turn_outcome",
      replyCounts: { progress: 0, final: 0, safeFallback: 0, daemonFallback: 1 },
    }));
  });

  it("reply safety fallback is terminal and never causes a second daemon fallback", async () => {
    deps.renderReply.mockResolvedValue({ text: "password: supersecret123", usage: null });
    deps.brain.turn.mockImplementationOnce((args) => runActive(args, async (turnContext) => {
      await handler.handleReply({
        sessionKey: "feishu:p2p:ou_a",
        kind: "message",
        brief: "答复",
        ...turnContext,
      });
      return { finalText: "内部", events: [] };
    }));
    const result = await handler.handleTurn({
      kind: "message", session, sessionKey: "feishu:p2p:ou_a", items, mode: "addressed",
    });
    expect(deps.outbound.sendMessage).toHaveBeenCalledTimes(1);
    expect(deps.outbound.sendMessage).toHaveBeenCalledWith(expect.objectContaining({ text: SAFE_REPLY_FALLBACK }));
    expect(result.receipt.terminal.outcome).toBe("safe_fallback_sent");
    expect(events).toContainEqual(expect.objectContaining({
      type: "business_turn_terminal", turnId: "turn-1", outcome: "safe_fallback_sent",
    }));
  });

  it("brain exception and empty result use the same fixed terminalizer without leaking errors", async () => {
    deps.brain.turn.mockRejectedValueOnce(new Error("secret stack: api_key=do-not-send-this"));
    const failed = await handler.handleTurn({
      kind: "message", session, sessionKey: "feishu:p2p:ou_a", items, mode: "addressed",
    });
    expect(deps.outbound.sendMessage).toHaveBeenCalledWith(expect.objectContaining({ text: DAEMON_TERMINAL_FALLBACK }));
    expect(JSON.stringify(deps.outbound.sendMessage.mock.calls)).not.toContain("do-not-send-this");
    expect(failed.receipt.terminal.outcome).toBe("daemon_fallback_sent");

    deps.outbound.sendMessage.mockClear();
    deps.brain.turn.mockResolvedValueOnce({ finalText: "", events: [] });
    const empty = await handler.handleTurn({
      kind: "message", session, sessionKey: "feishu:p2p:ou_a", items, mode: "addressed",
    });
    expect(deps.outbound.sendMessage).toHaveBeenCalledTimes(1);
    expect(empty.receipt.terminal.outcome).toBe("daemon_fallback_sent");
  });

  it("direct handler validates input before admission so invalid stage cannot hang close", async () => {
    const lease = deps.activeBrainTurns.activate({
      sessionKey: "feishu:p2p:ou_a",
      turnId: "turn-invalid",
      purpose: "business",
    });
    deps.activeBrainTurns.bindResident("feishu:p2p:ou_a", lease, 1);

    const result = await handler.handleReply({
      sessionKey: "feishu:p2p:ou_a",
      stage: "invalid",
      brief: "x",
      turnId: "turn-invalid",
      turnLease: lease,
      residentEpoch: 1,
    });

    expect(result).toMatchObject({ ok: false, error: expect.stringContaining("stage") });
    await expect(deps.activeBrainTurns.closeAdmissions("feishu:p2p:ou_a", lease))
      .resolves.toMatchObject({ state: "closing", inFlight: 0 });
    deps.activeBrainTurns.finalizeTurn("feishu:p2p:ou_a", lease);
    expect(deps.renderReply).not.toHaveBeenCalled();
    expect(deps.outbound.sendMessage).not.toHaveBeenCalled();
    expect(deps.outbound.sendCard).not.toHaveBeenCalled();
  });

  it("server rejects reply during memory maintenance with zero render/outbound", async () => {
    const lease = deps.activeBrainTurns.activate({
      sessionKey: "feishu:p2p:ou_a",
      turnId: "maintenance-1",
      purpose: "memory_maintenance",
    });
    deps.activeBrainTurns.bindResident("feishu:p2p:ou_a", lease, 1);
    const result = await handler.handleReply({
      sessionKey: "feishu:p2p:ou_a",
      kind: "message",
      brief: "不该发",
      residentEpoch: 1,
    });
    expect(result).toMatchObject({ ok: false, error: expect.stringContaining("maintenance") });
    expect(deps.renderReply).not.toHaveBeenCalled();
    expect(deps.outbound.sendMessage).not.toHaveBeenCalled();
    expect(deps.outbound.sendCard).not.toHaveBeenCalled();
    deps.activeBrainTurns.clear("feishu:p2p:ou_a", lease);
  });

  it("resident reply without a server-active brain turn is rejected", async () => {
    const result = await handler.handleReply({
      sessionKey: "feishu:p2p:ou_a",
      kind: "message",
      brief: "过期调用",
      residentEpoch: 1,
    });
    expect(result).toMatchObject({ ok: false, error: expect.stringContaining("active turn") });
    expect(deps.renderReply).not.toHaveBeenCalled();
    expect(deps.outbound.sendMessage).not.toHaveBeenCalled();
    expect(deps.outbound.sendCard).not.toHaveBeenCalled();
  });

  it("stale turn lease cannot terminalize a newer same-session business turn", async () => {
    const business = deps.activeTurns.begin({ sessionKey: "feishu:p2p:ou_a", purpose: "business" });
    const lease = deps.activeBrainTurns.activate({
      sessionKey: "feishu:p2p:ou_a",
      turnId: business.turnId,
      purpose: "business",
    });
    deps.activeBrainTurns.bindResident("feishu:p2p:ou_a", lease, 1);

    const result = await handler.handleReply({
      sessionKey: "feishu:p2p:ou_a",
      kind: "message",
      brief: "过期调用",
      turnId: business.turnId,
      turnLease: "stale-lease",
      residentEpoch: 1,
    });

    expect(result).toMatchObject({ ok: false, error: expect.stringContaining("context") });
    expect(deps.renderReply).not.toHaveBeenCalled();
    expect(deps.outbound.sendMessage).not.toHaveBeenCalled();
    expect(deps.outbound.sendCard).not.toHaveBeenCalled();
    expect(deps.activeTurns.resolve("feishu:p2p:ou_a").state).toBe("active");
    deps.activeBrainTurns.clear("feishu:p2p:ou_a", lease);
    deps.activeTurns.clear(business);
  });

  it("memory nudge runs as a separate silent maintenance turn and never enters the business brief", async () => {
    for (let i = 1; i <= 9; i++) {
      store.append(session.id, { role: "user", senderOpenId: "ou_a", content: `u${i}`, ts: i });
    }
    const result = await handler.handleTurn({
      kind: "message", session, sessionKey: "feishu:p2p:ou_a", items, mode: "addressed",
    });
    expect(deps.brain.turn).toHaveBeenCalledTimes(2);
    const business = deps.brain.turn.mock.calls.find(([arg]) => arg.purpose === "business")[0];
    const maintenance = deps.brain.turn.mock.calls.find(([arg]) => arg.purpose === "memory_maintenance")[0];
    expect(maintenance.brief).toContain("系统维护回合");
    expect(maintenance.brief).toContain("不要调用 reply");
    expect(business).toMatchObject({ purpose: "business", brief: "查资料" });
    expect(business.brief).not.toContain("系统提醒");
    expect(result.receipt.terminal.outcome).toBe("daemon_fallback_sent");
  });
});

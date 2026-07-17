import { describe, it, expect, vi, beforeEach } from "vitest";
import { openDb, migrate } from "../server/db/index.mjs";
import { createSessionStore } from "../server/sessions/store.mjs";
import { createTurnHandler } from "../server/gateway/turn-handler.mjs";

describe("旁听三层门控接线（规则→V4→5.5）", () => {
  let db, store, session, deps, handler, limiter;
  beforeEach(() => {
    db = openDb();
    migrate(db);
    store = createSessionStore(db);
    session = store.getOrCreate("feishu:group:oc_1", { kind: "group", chatId: "oc_1" });
    limiter = { allow: vi.fn(() => true), record: vi.fn() };
    deps = {
      triage: { triage: vi.fn(async () => ({ action: "no_reply" })) },
      brain: { turn: vi.fn(async () => ({ finalText: "", events: [] })), steer: vi.fn(), isBusy: () => false },
      renderReply: vi.fn(async () => ({ text: "x", usage: null })),
      outbound: { sendMessage: vi.fn(async () => ({ messageId: "om" })) },
      store,
      budget: { allow: () => ({ ok: true }), record: vi.fn() },
      limiter,
    };
    handler = createTurnHandler(deps);
  });

  const turn = (over = {}) => ({
    kind: "message", session, sessionKey: "feishu:group:oc_1",
    items: [{ content: "有人知道报销流程吗", senderOpenId: "ou_x", senderName: "同事", ts: 1000 }],
    mode: "ambient", ...over,
  });

  it("限额不过 → 短路：不调 triage（零模型成本），消息落 observed", async () => {
    limiter.allow.mockReturnValue(false);
    await handler.handleTurn(turn());
    expect(deps.triage.triage).not.toHaveBeenCalled();
    expect(store.transcript(session.id)[0].observed).toBe(1);
  });

  it("V4 判 no_reply → 落 observed，不出站不记账", async () => {
    await handler.handleTurn(turn());
    expect(deps.outbound.sendMessage).not.toHaveBeenCalled();
    expect(limiter.record).not.toHaveBeenCalled();
    expect(store.transcript(session.id)[0].observed).toBe(1);
  });

  it("V4 放行 quick_reply → 出站前记账", async () => {
    deps.triage.triage.mockResolvedValue({ action: "quick_reply", text: "流程在知识库第 3 节" });
    await handler.handleTurn(turn());
    expect(limiter.record).toHaveBeenCalledWith("oc_1", expect.anything());
    expect(deps.outbound.sendMessage).toHaveBeenCalled();
  });

  it("escalate → 记账后进 brain", async () => {
    deps.triage.triage.mockResolvedValue({ action: "escalate", brief: "帮忙查流程" });
    await handler.handleTurn(turn());
    expect(limiter.record).toHaveBeenCalled();
    expect(deps.brain.turn).toHaveBeenCalled();
  });

  it("addressed 模式不受限额器影响（@必答）", async () => {
    limiter.allow.mockReturnValue(false);
    deps.triage.triage.mockResolvedValue({ action: "quick_reply", text: "答" });
    await handler.handleTurn(turn({ mode: "addressed" }));
    expect(deps.outbound.sendMessage).toHaveBeenCalled();
  });

  // Task 7 C3.4：跨目标回写只是落库记录,不是"群内主动开口"——不消耗 ambient 限额
  it("跨目标投递回写不消耗群限额（limiter 零调用）", async () => {
    const { createDeliverGrants } = await import("../server/sessions/deliver-grants.mjs");
    const grants = createDeliverGrants();
    grants.grant("cron:job-1", "feishu:group:oc_1");
    const handler2 = createTurnHandler({ ...deps, grants, soul: "" });
    await handler2.handleReply({ sessionKey: "cron:job-1", brief: "播报", target: "feishu:group:oc_1" });
    expect(limiter.allow).not.toHaveBeenCalled();
    expect(limiter.record).not.toHaveBeenCalled();
    const target = store.getOrCreate("feishu:group:oc_1");
    expect(store.recent(target.id, { limit: 1 })[0].role).toBe("assistant");
  });
});

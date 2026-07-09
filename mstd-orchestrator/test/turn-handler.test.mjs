import { describe, it, expect, vi, beforeEach } from "vitest";
import { openDb, migrate } from "../server/db/index.mjs";
import { createSessionStore } from "../server/sessions/store.mjs";
import { createTurnHandler } from "../server/gateway/turn-handler.mjs";

const items = [{ content: "帮我查下周三的会", senderOpenId: "ou_a", senderName: "张三", ts: 1000 }];

describe("turn-handler（triage→brain→reply 全链）", () => {
  let db, store, session, deps, handler;
  beforeEach(() => {
    db = openDb();
    migrate(db);
    store = createSessionStore(db);
    session = store.getOrCreate("feishu:p2p:ou_a", { kind: "p2p" });
    deps = {
      triage: { triage: vi.fn() },
      brain: { turn: vi.fn(async () => ({ finalText: "裸文本不许出站", events: [] })), steer: vi.fn(), isBusy: () => false },
      renderReply: vi.fn(async () => ({ text: "渲染稿", usage: { total_tokens: 3 } })),
      outbound: { sendMessage: vi.fn(async () => ({ messageId: "om_9" })), editMessage: vi.fn() },
      store,
      budget: { allow: vi.fn(() => ({ ok: true })), record: vi.fn() },
      soul: "SOUL",
    };
    handler = createTurnHandler(deps);
  });

  it("quick_reply 直接出站并落库", async () => {
    deps.triage.triage.mockResolvedValue({ action: "quick_reply", text: "收到" });
    await handler.handleTurn({ kind: "message", session, sessionKey: "feishu:p2p:ou_a", items, mode: "addressed" });
    expect(deps.outbound.sendMessage).toHaveBeenCalledWith(expect.objectContaining({ text: "收到" }));
    const t = store.transcript(session.id);
    expect(t.map((m) => m.role)).toEqual(["user", "assistant"]);
    expect(deps.brain.turn).not.toHaveBeenCalled();
  });

  it("no_reply 静默：用户消息落 observed，不出站", async () => {
    deps.triage.triage.mockResolvedValue({ action: "no_reply" });
    await handler.handleTurn({ kind: "message", session, sessionKey: "feishu:p2p:ou_a", items, mode: "ambient" });
    expect(deps.outbound.sendMessage).not.toHaveBeenCalled();
    const t = store.transcript(session.id);
    expect(t).toHaveLength(1);
    expect(t[0].observed).toBe(1);
  });

  it("escalate 走 brain，brain 裸文本绝不出站", async () => {
    deps.triage.triage.mockResolvedValue({ action: "escalate", brief: "查会议" });
    await handler.handleTurn({ kind: "message", session, sessionKey: "feishu:p2p:ou_a", items, mode: "addressed" });
    expect(deps.brain.turn).toHaveBeenCalledWith(expect.objectContaining({ brief: "查会议" }));
    // 结构性强制：outbound 从未收到 brain 的 finalText
    for (const call of deps.outbound.sendMessage.mock.calls) {
      expect(call[0].text).not.toBe("裸文本不许出站");
    }
  });

  it("steer 分支注入 brain.steer", async () => {
    deps.brain.isBusy = () => true;
    deps.triage.triage.mockResolvedValue({ action: "steer", note: "改到后天" });
    await handler.handleTurn({ kind: "message", session, sessionKey: "feishu:p2p:ou_a", items, mode: "addressed" });
    expect(deps.brain.steer).toHaveBeenCalledWith("feishu:p2p:ou_a", "改到后天");
  });

  it("budget 超限：礼貌拒绝模板出站，不调 triage", async () => {
    deps.budget.allow.mockReturnValue({ ok: false, scope: "daily" });
    await handler.handleTurn({ kind: "message", session, sessionKey: "feishu:p2p:ou_a", items, mode: "addressed" });
    expect(deps.triage.triage).not.toHaveBeenCalled();
    expect(deps.outbound.sendMessage).toHaveBeenCalledWith(expect.objectContaining({ text: expect.stringContaining("额度") }));
  });

  it("handleReply：渲染→出站→落库→记账（5.5 经内部通道的唯一出口）", async () => {
    const out = await handler.handleReply({ sessionKey: "feishu:p2p:ou_a", kind: "message", brief: "告诉他周三 14:00" });
    expect(deps.renderReply).toHaveBeenCalledWith(expect.objectContaining({ brief: "告诉他周三 14:00", soul: "SOUL" }));
    expect(deps.outbound.sendMessage).toHaveBeenCalledWith(expect.objectContaining({ openId: "ou_a", text: "渲染稿" }));
    expect(out).toMatchObject({ ok: true, text: "渲染稿", message_id: "om_9" });
    expect(store.transcript(session.id).at(-1).content).toBe("渲染稿");
    expect(deps.budget.record).toHaveBeenCalled();
  });

  it("handleReply card_copy 只渲染不出站", async () => {
    const out = await handler.handleReply({ sessionKey: "feishu:p2p:ou_a", kind: "card_copy", brief: "确认建任务文案" });
    expect(out).toMatchObject({ ok: true, text: "渲染稿" });
    expect(deps.outbound.sendMessage).not.toHaveBeenCalled();
  });
});

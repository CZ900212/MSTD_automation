import { describe, it, expect, vi, beforeEach } from "vitest";
import { openDb, migrate } from "../server/db/index.mjs";
import { createSessionStore } from "../server/sessions/store.mjs";
import { createTurnHandler } from "../server/gateway/turn-handler.mjs";
import { createDeliverGrants } from "../server/sessions/deliver-grants.mjs";

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
      grants: createDeliverGrants(),
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

  // Task 6：handleReply 的 context 走 store.recent——真"最近"且 tool 行标 [内部记录]
  it("handleReply context 取最近消息且 tool 行不冒充用户", async () => {
    for (let i = 1; i <= 25; i++) store.append(session.id, { role: "user", senderName: "张三", content: `m${i}`, ts: i });
    store.append(session.id, { role: "tool", content: "内部X", ts: 100 });
    store.append(session.id, { role: "system", content: "〔压缩摘要〕内部结论", ts: 101 });   // 窗口内的 system 行
    const recentSpy = vi.spyOn(store, "recent");
    await handler.handleReply({ sessionKey: "feishu:p2p:ou_a", kind: "message", brief: "回一下" });
    // 精确 roles 契约：不许"先取全角色再 JS 过滤"的等价改写悄悄回退
    expect(recentSpy).toHaveBeenCalledWith(session.id, { limit: 20, roles: ["user", "assistant", "tool"] });
    const ctx = deps.renderReply.mock.calls[0][0].context;
    expect(ctx).toContain("[内部记录]: 内部X");
    expect(ctx).not.toContain("[用户]: 内部X");
    expect(ctx).toContain("[张三]: m25");            // 近期语义：必须包含最新消息,不是最旧 20 条
    expect(ctx).not.toContain("压缩摘要");            // system 摘要不得冒充任何人泄入 reply 上下文
  });

  it("handleReply card_copy 只渲染不出站", async () => {
    const out = await handler.handleReply({ sessionKey: "feishu:p2p:ou_a", kind: "card_copy", brief: "确认建任务文案" });
    expect(out).toMatchObject({ ok: true, text: "渲染稿" });
    expect(deps.outbound.sendMessage).not.toHaveBeenCalled();
  });

  it("handleReply：未 grant 的跨会话 target → 越权错误,render 前拦截,零出站", async () => {
    const out = await handler.handleReply({ sessionKey: "feishu:p2p:ou_a", kind: "message", brief: "偷发", target: "feishu:p2p:ou_victim" });
    expect(out.ok).toBe(false);
    expect(out.error).toContain("越权");
    expect(deps.renderReply).not.toHaveBeenCalled();      // render 前就拦
    expect(deps.outbound.sendMessage).not.toHaveBeenCalled();
    expect(store.transcript(session.id)).toHaveLength(0); // 也不落库
  });

  it("handleReply：grant 后放行指定 target;target=本会话等价省略恒放行", async () => {
    deps.grants.grant("feishu:p2p:ou_a", "feishu:group:oc_t");
    const out = await handler.handleReply({ sessionKey: "feishu:p2p:ou_a", kind: "message", brief: "播报", target: "feishu:group:oc_t" });
    expect(out).toMatchObject({ ok: true, text: "渲染稿" });
    expect(deps.outbound.sendMessage).toHaveBeenCalledWith(expect.objectContaining({ chatId: "oc_t", text: "渲染稿" }));

    deps.outbound.sendMessage.mockClear();
    const self = await handler.handleReply({ sessionKey: "feishu:p2p:ou_a", kind: "message", brief: "自会话", target: "feishu:p2p:ou_a" });
    expect(self.ok).toBe(true);
    expect(deps.outbound.sendMessage).toHaveBeenCalledWith(expect.objectContaining({ openId: "ou_a" }));
  });

  it("未注入 grants 时跨会话 target fail-closed", async () => {
    const bare = createTurnHandler({ ...deps, grants: undefined });
    const out = await bare.handleReply({ sessionKey: "feishu:p2p:ou_a", kind: "message", brief: "x", target: "feishu:p2p:ou_b" });
    expect(out.ok).toBe(false);
    expect(deps.outbound.sendMessage).not.toHaveBeenCalled();
  });

  it("deliverTrusted：daemon 直投确定性提醒,带幂等键,回写目标 transcript 且 chat_id 正确", async () => {
    const r = await handler.deliverTrusted({ deliverKey: "feishu:group:oc_x", text: "开会", idempotencyKey: "heartbeat:item-1" });
    expect(r.ok).toBe(true);
    expect(deps.outbound.sendMessage).toHaveBeenCalledTimes(1);
    expect(deps.outbound.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({ chatId: "oc_x", text: "提醒：开会", idempotencyKey: "heartbeat:item-1" })
    );
    expect(deps.renderReply).not.toHaveBeenCalled();      // 确定性文案不走渲染链
    const target = store.getOrCreate("feishu:group:oc_x");
    expect(target.chat_id).toBe("oc_x");                  // 目标 session 的 chat_id 回填
    const t = store.transcript(target.id);
    expect(t.at(-1)).toMatchObject({ role: "assistant", content: "提醒：开会", platform_message_id: "om_9" });
  });

  it("deliverTrusted：p2p 目标走 openId 出站并落对方 transcript", async () => {
    const r = await handler.deliverTrusted({ deliverKey: "feishu:p2p:ou_b", text: "喝水", idempotencyKey: "heartbeat:item-2" });
    expect(r).toMatchObject({ ok: true, message_id: "om_9" });
    expect(deps.outbound.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({ openId: "ou_b", text: "提醒：喝水", idempotencyKey: "heartbeat:item-2" })
    );
    const target = store.getOrCreate("feishu:p2p:ou_b");
    expect(store.transcript(target.id).at(-1).content).toBe("提醒：喝水");
  });
});

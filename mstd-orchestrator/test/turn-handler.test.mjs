import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { openDb, migrate } from "../server/db/index.mjs";
import { createSessionStore } from "../server/sessions/store.mjs";
import { createTurnHandler, DAEMON_TERMINAL_FALLBACK } from "../server/gateway/turn-handler.mjs";
import { createDeliverGrants } from "../server/sessions/deliver-grants.mjs";
import { createTriage } from "../server/models/triage.mjs";

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
      outbound: { sendMessage: vi.fn(async () => ({ messageId: "om_9" })), sendCard: vi.fn(async () => ({ messageId: "om_card_9" })), editMessage: vi.fn() },
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

  // P0：handleReply 只读 prompt allowlist；tool-internal 不得进入渲染上下文。
  it("handleReply context 取最近 eligible 消息且排除 tool-internal", async () => {
    for (let i = 1; i <= 25; i++) store.append(session.id, { role: "user", senderName: "张三", content: `m${i}`, ts: i });
    store.append(session.id, {
      role: "tool", content: "内部X", ts: 100,
      policy: { replayable: false, promptEligible: false, memoryEligible: false, securityLabel: "internal", provenance: "tool_internal" },
    });
    store.append(session.id, { role: "system", content: "〔压缩摘要〕内部结论", ts: 101 });   // 窗口内的 system 行
    const recentSpy = vi.spyOn(store, "promptRecent");
    await handler.handleReply({ sessionKey: "feishu:p2p:ou_a", kind: "message", brief: "回一下" });
    // 精确 roles 契约：不许"先取全角色再 JS 过滤"的等价改写悄悄回退
    expect(recentSpy).toHaveBeenCalledWith(session.id, { limit: 20, roles: ["user", "assistant", "tool"] });
    const ctx = deps.renderReply.mock.calls[0][0].context;
    expect(ctx).not.toContain("内部X");
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

  // Task 10 C4:deliverKind 生产链路——scene 由 deliverKey 决定,不是只在直接调用 renderReply 时存在
  it("C4 deliverKind:cron→group grant 走 group;p2p 当前会话走 p2p;debug 按 p2p", async () => {
    deps.grants.grant("cron:job-1", "feishu:group:oc_1");
    const out = await handler.handleReply({ sessionKey: "cron:job-1", kind: "message", brief: "播报", target: "feishu:group:oc_1" });
    expect(out.ok).toBe(true);
    expect(deps.renderReply).toHaveBeenCalledWith(expect.objectContaining({ deliverKind: "group" }));
    expect(deps.outbound.sendMessage).toHaveBeenCalledWith(expect.objectContaining({ chatId: "oc_1" }));

    deps.renderReply.mockClear();
    await handler.handleReply({ sessionKey: "feishu:p2p:ou_a", kind: "message", brief: "回复" });
    expect(deps.renderReply).toHaveBeenCalledWith(expect.objectContaining({ deliverKind: "p2p" }));

    deps.renderReply.mockClear();
    await handler.handleReply({ sessionKey: "debug:web-u1", kind: "message", brief: "调试" });
    expect(deps.renderReply).toHaveBeenCalledWith(expect.objectContaining({ deliverKind: "p2p" }));
  });

  // Task 11 C6:唯一文本出口 deliverText——Markdown 走消息卡,纯文本走 text,绝不双发
  it("C6 quick_reply/正式 reply 共用 deliverText:md→sendCard,纯文本→sendMessage", async () => {
    const md = "| a | b |\n|---|---|\n| 1 | 2 |";
    // 1. quick_reply 表格 → sendCard,body 唯一元素 tag=markdown
    deps.triage.triage.mockResolvedValue({ action: "quick_reply", text: md });
    await handler.handleTurn({ kind: "message", session, sessionKey: "feishu:p2p:ou_a", items, mode: "addressed" });
    expect(deps.outbound.sendCard).toHaveBeenCalledTimes(1);
    const cardArg = deps.outbound.sendCard.mock.calls[0][0];
    expect(cardArg.openId).toBe("ou_a");
    expect(cardArg.cardJson.body.elements).toEqual([{ tag: "markdown", content: md }]);
    expect(deps.outbound.sendMessage).not.toHaveBeenCalled();     // 不双发

    // 2. quick_reply 纯文本 → sendMessage
    deps.outbound.sendCard.mockClear(); deps.outbound.sendMessage.mockClear();
    deps.triage.triage.mockResolvedValue({ action: "quick_reply", text: "收到" });
    await handler.handleTurn({ kind: "message", session, sessionKey: "feishu:p2p:ou_a", items, mode: "addressed" });
    expect(deps.outbound.sendMessage).toHaveBeenCalledTimes(1);
    expect(deps.outbound.sendCard).not.toHaveBeenCalled();

    // 3. 已 grant 的 cron handleReply 渲染出表格且 target group → sendCard(chatId=oc_1)
    deps.outbound.sendCard.mockClear(); deps.outbound.sendMessage.mockClear();
    deps.renderReply.mockResolvedValue({ text: md, usage: null });
    deps.grants.grant("cron:job-1", "feishu:group:oc_1");
    const out = await handler.handleReply({ sessionKey: "cron:job-1", kind: "message", brief: "播报", target: "feishu:group:oc_1" });
    expect(out.ok).toBe(true);
    expect(deps.outbound.sendCard).toHaveBeenCalledWith(expect.objectContaining({ chatId: "oc_1" }));
    expect(deps.outbound.sendMessage).not.toHaveBeenCalled();

    // 4. p2p handleReply 纯文本 → sendMessage(openId=ou_a)
    deps.outbound.sendCard.mockClear(); deps.outbound.sendMessage.mockClear();
    deps.renderReply.mockResolvedValue({ text: "纯文本回复", usage: null });
    await handler.handleReply({ sessionKey: "feishu:p2p:ou_a", kind: "message", brief: "回复" });
    expect(deps.outbound.sendMessage).toHaveBeenCalledWith(expect.objectContaining({ openId: "ou_a", text: "纯文本回复" }));
    expect(deps.outbound.sendCard).not.toHaveBeenCalled();
  });

  // §5.2 审卷补杀:零出站断言必须同时盖住 sendMessage 与 sendCard;出站路径恰一次
  it("C6 零出站语义盖双通道:no_reply/card_copy/越权/budget 拒绝都不许发卡", async () => {
    deps.triage.triage.mockResolvedValue({ action: "no_reply" });
    await handler.handleTurn({ kind: "message", session, sessionKey: "feishu:p2p:ou_a", items, mode: "ambient" });
    expect(deps.outbound.sendCard).not.toHaveBeenCalled();

    await handler.handleReply({ sessionKey: "feishu:p2p:ou_a", kind: "card_copy", brief: "文案" });
    expect(deps.outbound.sendCard).not.toHaveBeenCalled();
    expect(deps.outbound.sendMessage).not.toHaveBeenCalled();

    const denied = await handler.handleReply({ sessionKey: "feishu:p2p:ou_a", kind: "message", brief: "偷发", target: "feishu:p2p:ou_v" });
    expect(denied.ok).toBe(false);
    expect(deps.outbound.sendCard).not.toHaveBeenCalled();

    deps.budget.allow.mockReturnValue({ ok: false, scope: "daily" });
    await handler.handleTurn({ kind: "message", session, sessionKey: "feishu:p2p:ou_a", items, mode: "addressed" });
    expect(deps.outbound.sendMessage).toHaveBeenCalledTimes(1);   // 拒绝文案恰一次
    expect(deps.outbound.sendCard).not.toHaveBeenCalled();
  });

  // §5.2 审卷补杀:默认幂等键被删即红——隐式路径也必须带非空 string key
  it("C6 隐式幂等键:quick_reply 文本与 md 卡片路径都带非空 idempotencyKey", async () => {
    deps.triage.triage.mockResolvedValue({ action: "quick_reply", text: "收到" });
    await handler.handleTurn({ kind: "message", session, sessionKey: "feishu:p2p:ou_a", items, mode: "addressed" });
    const k1 = deps.outbound.sendMessage.mock.calls[0][0].idempotencyKey;
    expect(typeof k1).toBe("string");
    expect(k1.length).toBeGreaterThan(0);

    deps.triage.triage.mockResolvedValue({ action: "quick_reply", text: "# 标题\n内容" });
    await handler.handleTurn({ kind: "message", session, sessionKey: "feishu:p2p:ou_a", items, mode: "addressed" });
    const k2 = deps.outbound.sendCard.mock.calls[0][0].idempotencyKey;
    expect(typeof k2).toBe("string");
    expect(k2.length).toBeGreaterThan(0);
    expect(k2).not.toBe(k1);
  });

  // §5.2 审卷补杀:debug"不真发"语义锁——md 也不发卡,platformMessageId 落 null
  it("C6 debug 会话:md 也零出站,落库即出站且 platform_message_id 为空", async () => {
    const dbg = store.getOrCreate("debug:web-u1", { kind: "debug" });
    deps.renderReply.mockResolvedValue({ text: "# 富文本\n| a |\n|---|", usage: null });
    const out = await handler.handleReply({ sessionKey: "debug:web-u1", kind: "message", brief: "调试" });
    expect(out.ok).toBe(true);
    expect(deps.outbound.sendMessage).not.toHaveBeenCalled();
    expect(deps.outbound.sendCard).not.toHaveBeenCalled();
    const rows = store.transcript(dbg.id);
    expect(rows.at(-1).role).toBe("assistant");
    expect(rows.at(-1).platform_message_id ?? null).toBeNull();
  });

  // §5.2 审卷补杀:不可出站会话的 guard 可达——cron 自会话 reply 必须炸,零出站零落库
  it("C6 cron 自会话(无 target):deliverText 拒绝,零出站零 assistant", async () => {
    const cronSession = store.getOrCreate("cron:job-9", { kind: "p2p" });
    await expect(handler.handleReply({ sessionKey: "cron:job-9", kind: "message", brief: "x" }))
      .rejects.toThrow(/不可出站/);
    expect(deps.outbound.sendMessage).not.toHaveBeenCalled();
    expect(deps.outbound.sendCard).not.toHaveBeenCalled();
    expect(store.transcript(cronSession.id).filter((r) => r.role === "assistant")).toHaveLength(0);
  });

  // §5.2 审卷补杀:deliverKind 场景矩阵表驱动(杀"部分来源用 sessionKey"的杂交变异)
  it.each([
    ["feishu:group:oc_g", undefined, "group", "群自会话"],
    ["feishu:p2p:ou_a", "feishu:group:oc_1", "group", "p2p→group"],
    ["feishu:group:oc_g", "feishu:p2p:ou_b", "p2p", "group→p2p"],
    ["cron:job-1", "feishu:p2p:ou_b", "p2p", "cron→p2p"],
  ])("C4 deliverKind 矩阵:%s target=%s → %s(%s)", async (sessionKey, target, want) => {
    store.getOrCreate(sessionKey, sessionKey.startsWith("feishu:group:") ? { kind: "group", chatId: sessionKey.split(":")[2] } : { kind: "p2p" });
    if (target) deps.grants.grant(sessionKey, target);
    const out = await handler.handleReply({ sessionKey, kind: "message", brief: "x", target });
    expect(out.ok).toBe(true);
    expect(deps.renderReply).toHaveBeenCalledWith(expect.objectContaining({ deliverKind: want }));
  });

  // §5.2 审卷补杀:parseSessionKey 抛错兜底 p2p 的 catch 分支真被走到(card_copy 隔离出站)
  it("C4 不可解析 target:catch 兜底 p2p,card_copy 不出站", async () => {
    deps.grants.grant("feishu:p2p:ou_a", "weird-key-no-colon-format");
    await handler.handleReply({ sessionKey: "feishu:p2p:ou_a", kind: "card_copy", brief: "文案", target: "weird-key-no-colon-format" });
    expect(deps.renderReply).toHaveBeenCalledWith(expect.objectContaining({ deliverKind: "p2p" }));
    expect(deps.outbound.sendMessage).not.toHaveBeenCalled();
    expect(deps.outbound.sendCard).not.toHaveBeenCalled();
  });

  // §5.2 审卷补杀:卡片 messageId 传播 + sendCard 失败原子性(零 assistant 落库)
  it("C6 卡片 message_id 落库;sendCard 失败不落 assistant", async () => {
    deps.triage.triage.mockResolvedValue({ action: "quick_reply", text: "# 表\n| a |\n|---|" });
    await handler.handleTurn({ kind: "message", session, sessionKey: "feishu:p2p:ou_a", items, mode: "addressed" });
    const rows = store.transcript(session.id);
    expect(rows.at(-1).platform_message_id).toBe("om_card_9");

    deps.outbound.sendCard.mockRejectedValueOnce(new Error("card api down"));
    deps.renderReply.mockResolvedValue({ text: "# 又一个富文本标题\n正文", usage: null });
    const before = store.transcript(session.id).length;
    await expect(handler.handleReply({ sessionKey: "feishu:p2p:ou_a", kind: "message", brief: "x" }))
      .rejects.toThrow("card api down");
    expect(store.transcript(session.id)).toHaveLength(before);    // 失败零落库
  });

  // §5.2 审卷补杀:结构锁——outbound.send* 只许出现在 reply-pipeline 的 deliverText 实现内
  // (恰 3 处:富 md 卡片/atomic 多段合卡/纯文本循环);turn-handler 拆分后必须零直调。
  // 新路径想直调 outbound 必须先来改这条测试,评审自然看见
  it("C6 结构锁:reply-pipeline 源码 outbound.send 调用恰 3 处(均在 deliverText);turn-handler 零处", () => {
    const pipelineSrc = readFileSync(new URL("../server/gateway/reply-pipeline.mjs", import.meta.url), "utf8");
    expect(pipelineSrc.match(/outbound\.send(Message|Card)\(/g)).toHaveLength(3);
    const handlerSrc = readFileSync(new URL("../server/gateway/turn-handler.mjs", import.meta.url), "utf8");
    expect(handlerSrc.match(/outbound\.send(Message|Card)\(/g)).toBeNull();
  });

  it("结构锁：active turn 依赖只归一化一次，发送并落库由 sendAndRecord 单点持有", () => {
    const src = readFileSync(new URL("../server/gateway/turn-handler.mjs", import.meta.url), "utf8");
    expect(src).not.toMatch(/activeTurns\?\./);
    expect(src).toMatch(/const receipts = activeTurns \?\? createActiveTurnRegistry\(\)\.receipts/);
    expect(src).toMatch(/async function sendAndRecord\(/);
  });

  it("C6 deliverText 幂等键透传:卡片路径也带 idempotencyKey", async () => {
    // deliverTrusted 前缀"提醒："后表格信号仍在行首,应走卡片
    const md = "开会安排\n| 时间 | 地点 |\n|---|---|\n| 15:00 | 3F |";
    const r = await handler.deliverTrusted({ deliverKey: "feishu:group:oc_x", text: md, idempotencyKey: "hb:1" });
    expect(r.ok).toBe(true);
    expect(deps.outbound.sendCard).toHaveBeenCalledWith(expect.objectContaining({ idempotencyKey: "hb:1" }));
    expect(deps.outbound.sendMessage).not.toHaveBeenCalled();
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

  // ---- Task 7 C3.3/3.4/3.5 ----
  const t = (h, m) => Date.UTC(2026, 6, 10, h - 8, m);          // 北京 HH:MM 对应的 epoch

  it("C3.3 群窗口严格最近30条、排除 tool 与当前批,含自身发言,带 HH:MM", async () => {
    const gs = store.getOrCreate("feishu:group:oc_1", { kind: "group", chatId: "oc_1" });
    deps.triage.triage.mockResolvedValue({ action: "escalate", brief: "复述" });
    for (let i = 1; i <= 35; i++) store.append(gs.id, {
      role: i === 35 ? "assistant" : "user", senderName: `员工${i}`, content: `m${i}`, observed: true, ts: t(20, i),
    });
    store.append(gs.id, { role: "tool", content: "内部不该出现", ts: t(21, 0) });
    store.append(gs.id, { role: "system", content: "〔压缩摘要〕内部摘要不该出现", ts: t(21, 1) });
    await handler.handleTurn({ kind: "message", session: gs, sessionKey: "feishu:group:oc_1",
      items: [{ senderName: "李四", content: "[@我] 当前批", ts: t(21, 48) }], mode: "addressed" });
    const ctx = deps.brain.turn.mock.calls[0][0].context;
    const block = ctx.match(/\[群内最近消息-截至本批之前\]\n([\s\S]*?)\n\[\/群内最近消息\]/)[1].split("\n");
    expect(block).toHaveLength(30);
    expect(block.join("\n")).toContain("m6");
    expect(block.join("\n")).toContain("[我]: m35");
    expect(block.some((l) => l.endsWith(": m5"))).toBe(false);   // 第 31 旧的 m5 已滚出窗口
    expect(block.join("\n")).not.toContain("内部不该出现");
    expect(block.join("\n")).not.toContain("内部摘要不该出现");   // system 同样排除
    expect(block.join("\n")).not.toContain("当前批");
    expect(block.every((l) => /^\d{2}:\d{2} \[/.test(l))).toBe(true);   // 每一行都带 HH:MM
    expect(block[0]).toMatch(/^20:06 /);                       // 北京时间(注:本机为 UTC+8,时区变异需 CI 异区兜底)
    expect(ctx).toContain("[/群内最近消息]\n\n");                // 块与本批之间的规定边界
    expect(ctx.slice(ctx.indexOf("[/群内最近消息]"))).toContain("当前批");
    expect(ctx.match(/当前批/g)).toHaveLength(1);
  });

  // §5.2 审卷补杀:窗口只在群 addressed 的 escalate 注入——p2p addressed 与群 ambient 都不得有
  it("C3.3 窗口作用域负向:p2p addressed 与群 ambient 无窗口定界符", async () => {
    deps.triage.triage.mockResolvedValue({ action: "escalate", brief: "问" });
    store.append(session.id, { role: "user", senderOpenId: "ou_a", content: "早", ts: 1 });
    await handler.handleTurn({ kind: "message", session, sessionKey: "feishu:p2p:ou_a", items, mode: "addressed" });
    expect(deps.brain.turn.mock.calls[0][0].context).not.toContain("群内最近消息");
    const gs = store.getOrCreate("feishu:group:oc_1", { kind: "group", chatId: "oc_1" });
    store.append(gs.id, { role: "user", senderName: "甲", content: "闲聊", observed: true, ts: 1 });
    await handler.handleTurn({ kind: "message", session: gs, sessionKey: "feishu:group:oc_1",
      items: [{ content: "路过", senderOpenId: "ou_x", ts: 2 }], mode: "ambient" });
    expect(deps.brain.turn.mock.calls[1][0].context).not.toContain("群内最近消息");
  });

  it("C3.3 复述二连问都有料(不再一次性消费)", async () => {
    const gs = store.getOrCreate("feishu:group:oc_1", { kind: "group", chatId: "oc_1" });
    deps.triage.triage.mockResolvedValue({ action: "escalate", brief: "复述" });
    store.append(gs.id, { role: "user", senderName: "张三", content: "球赛绝了", observed: true, ts: 1000 });
    await handler.handleTurn({ kind: "message", session: gs, sessionKey: "feishu:group:oc_1",
      items: [{ senderName: "李四", content: "[@我] 复述", ts: 2000 }], mode: "addressed" });
    await handler.handleTurn({ kind: "message", session: gs, sessionKey: "feishu:group:oc_1",
      items: [{ senderName: "李四", content: "[@我] 再复述一次", ts: 3000 }], mode: "addressed" });
    const ctx2 = deps.brain.turn.mock.calls[1][0].context;
    expect(ctx2).toContain("球赛绝了");                        // 第二问仍可见
    // 第二问本体恰一次且在窗口块之后——缓存首轮 context 的等价改写会丢第二问,必须红
    expect(ctx2.match(/再复述一次/g)).toHaveLength(1);
    expect(ctx2.indexOf("再复述一次")).toBeGreaterThan(ctx2.indexOf("[/群内最近消息]"));
    expect(ctx2).not.toContain("自你上次发言以来");            // 旧一次性消费定界符已退役
  });

  it("C3.4 跨目标投递回写目标 session transcript(带 chat_id meta),源/目标各恰一条完整记录", async () => {
    deps.grants.grant("cron:job-9", "feishu:group:oc_1");
    await handler.handleReply({ sessionKey: "cron:job-9", brief: "播报", target: "feishu:group:oc_1" });
    const target = store.getOrCreate("feishu:group:oc_1");
    expect(target.chat_id).toBe("oc_1");                       // 评审修正:必须带 meta,不许 chat_id=null
    const src = store.getOrCreate("cron:job-9");
    const count = (sid) => db.prepare(
      "SELECT COUNT(*) n FROM agent_messages WHERE session_id = ? AND role='assistant' AND content='渲染稿' AND platform_message_id='om_9'"
    ).get(sid).n;
    expect(count(src.id)).toBe(1);                             // 源恰一条(含 platform_message_id)
    expect(count(target.id)).toBe(1);                          // 目标恰一条,不重复
  });

  // §5.2 审卷补杀:出站成功后才回写——send 失败时源/目标零落库
  it("C3.4 出站失败:源与目标 transcript 都不落库", async () => {
    deps.grants.grant("cron:job-9", "feishu:group:oc_1");
    deps.outbound.sendMessage.mockRejectedValueOnce(new Error("lark down"));
    await expect(handler.handleReply({ sessionKey: "cron:job-9", brief: "播报", target: "feishu:group:oc_1" })).rejects.toThrow();
    const n = db.prepare("SELECT COUNT(*) n FROM agent_messages").get().n;
    expect(n).toBe(0);
  });

  // §5.2 审卷补杀:p2p 跨目标回写正向 + debug 目标不回写
  it("C3.4 跨目标 p2p 回写;debug 目标出站但不建目标 transcript", async () => {
    deps.grants.grant("cron:job-9", "feishu:p2p:ou_c");
    await handler.handleReply({ sessionKey: "cron:job-9", brief: "私聊播报", target: "feishu:p2p:ou_c" });
    const p2pTarget = store.getOrCreate("feishu:p2p:ou_c");
    expect(store.recent(p2pTarget.id, { limit: 1 })[0].role).toBe("assistant");
    deps.grants.grant("cron:job-9", "debug:d1");
    const r = await handler.handleReply({ sessionKey: "cron:job-9", brief: "调试", target: "debug:d1" });
    expect(r.ok).toBe(true);
    expect(db.prepare("SELECT 1 FROM agent_sessions WHERE session_key = 'debug:d1'").get()).toBeUndefined();
  });

  // §5.2 审卷补杀:deliverKey===sessionKey(无 target/自指 target)不双写
  it("C3.4 无 target 与显式 self-target 各只落一条", async () => {
    await handler.handleReply({ sessionKey: "feishu:p2p:ou_a", kind: "message", brief: "x" });
    expect(db.prepare("SELECT COUNT(*) n FROM agent_messages WHERE session_id = ?").get(session.id).n).toBe(1);
    await handler.handleReply({ sessionKey: "feishu:p2p:ou_a", kind: "message", brief: "y", target: "feishu:p2p:ou_a" });
    expect(db.prepare("SELECT COUNT(*) n FROM agent_messages WHERE session_id = ?").get(session.id).n).toBe(2);
  });

  it("C3.5 nudge 走独立维护回合:第 10 条后恰运行一次,绝不混入业务 brief", async () => {
    deps.triage.triage.mockResolvedValue({ action: "escalate", brief: "问" });
    for (let i = 1; i <= 9; i++) store.append(session.id, { role: "user", senderOpenId: "ou_a", content: `u${i}`, ts: i });
    await handler.handleTurn({ kind: "message", session, sessionKey: "feishu:p2p:ou_a", items, mode: "addressed" });
    expect(deps.brain.turn.mock.calls[0][0]).toMatchObject({ purpose: "business", brief: "问" });
    expect(deps.brain.turn.mock.calls[1][0].purpose).toBe("memory_maintenance");
    expect(deps.brain.turn.mock.calls[1][0].brief).toContain("系统维护回合");
    expect(deps.brain.turn.mock.calls[1][0].brief).toContain("不要调用 reply");
    await handler.handleTurn({ kind: "message", session, sessionKey: "feishu:p2p:ou_a", items: [{ content: "追问", senderOpenId: "ou_a", ts: 99 }], mode: "addressed" });
    expect(deps.brain.turn.mock.calls.filter(([arg]) => arg.purpose === "memory_maintenance")).toHaveLength(1);
  });

  it("C3.5 独立 maintenance 失败不消费水位,下回合重试且不影响业务终态", async () => {
    deps.triage.triage.mockResolvedValue({ action: "escalate", brief: "问" });
    let failedOnce = false;
    deps.brain.turn.mockImplementation(async ({ purpose }) => {
      if (purpose === "memory_maintenance" && !failedOnce) {
        failedOnce = true;
        throw new Error("网关 503");
      }
      return { finalText: "内部", events: [] };
    });
    for (let i = 1; i <= 9; i++) store.append(session.id, { role: "user", senderOpenId: "ou_a", content: `u${i}`, ts: i });
    await handler.handleTurn({ kind: "message", session, sessionKey: "feishu:p2p:ou_a", items, mode: "addressed" });
    await handler.handleTurn({ kind: "message", session, sessionKey: "feishu:p2p:ou_a", items: [{ content: "再来", senderOpenId: "ou_a", ts: 99 }], mode: "addressed" });
    const maintenance = deps.brain.turn.mock.calls.filter(([arg]) => arg.purpose === "memory_maintenance");
    expect(maintenance).toHaveLength(2);
    expect(maintenance.every(([arg]) => arg.brief.includes("不要调用 reply"))).toBe(true);
    await handler.handleTurn({ kind: "message", session, sessionKey: "feishu:p2p:ou_a", items: [{ content: "又来", senderOpenId: "ou_a", ts: 100 }], mode: "addressed" });
    expect(deps.brain.turn.mock.calls.filter(([arg]) => arg.purpose === "memory_maintenance")).toHaveLength(2);
  });
});

// 2026-07-12 用户定案两条:①消息里绝不带空行(空行即拆分成多条);②快机永远先应答(escalate 带 ack)
describe("空行拆分与快机先应答", () => {
  let db, store, session, deps, handler;
  beforeEach(() => {
    db = openDb();
    migrate(db);
    store = createSessionStore(db);
    session = store.getOrCreate("feishu:p2p:ou_a", { kind: "p2p" });
    deps = {
      triage: { triage: vi.fn() },
      brain: { turn: vi.fn(async () => ({ finalText: "内部结论", events: [] })), steer: vi.fn(), isBusy: () => false },
      renderReply: vi.fn(async () => ({ text: "渲染稿", usage: null })),
      outbound: { sendMessage: vi.fn(async () => ({ messageId: "om_9" })), sendCard: vi.fn(async () => ({ messageId: "om_card_9" })), editMessage: vi.fn() },
      store,
      budget: { allow: vi.fn(() => ({ ok: true })), record: vi.fn() },
      soul: "SOUL",
      grants: createDeliverGrants(),
    };
    handler = createTurnHandler(deps);
  });

  it("纯文本含空行:按空段拆成多条顺序出站,幂等 key 按段派生且互不相同", async () => {
    deps.triage.triage.mockResolvedValue({ action: "quick_reply", text: "第一段\n还是第一段\n\n第二段\n\n\n第三段" });
    await handler.handleTurn({ kind: "message", session, sessionKey: "feishu:p2p:ou_a", items, mode: "addressed" });
    const calls = deps.outbound.sendMessage.mock.calls.map((c) => c[0]);
    expect(calls.map((c) => c.text)).toEqual(["第一段\n还是第一段", "第二段", "第三段"]);
    const keys = calls.map((c) => c.idempotencyKey);
    expect(new Set(keys).size).toBe(3);
    expect(calls.every((c) => !/\n\s*\n/.test(c.text))).toBe(true);   // 任何一条都无空行
  });

  it("无空行的纯文本仍单条出站;富 markdown 走卡片不拆分", async () => {
    deps.triage.triage.mockResolvedValue({ action: "quick_reply", text: "就一条" });
    await handler.handleTurn({ kind: "message", session, sessionKey: "feishu:p2p:ou_a", items, mode: "addressed" });
    expect(deps.outbound.sendMessage).toHaveBeenCalledTimes(1);
    deps.outbound.sendMessage.mockClear();
    deps.triage.triage.mockResolvedValue({ action: "quick_reply", text: "| a | b |\n|---|---|\n| 1 | 2 |\n\n表格说明" });
    await handler.handleTurn({ kind: "message", session, sessionKey: "feishu:p2p:ou_a", items, mode: "addressed" });
    expect(deps.outbound.sendCard).toHaveBeenCalledTimes(1);
    expect(deps.outbound.sendMessage).not.toHaveBeenCalled();
  });

  it("escalate 带 ack:先出站 ack 并落库,再进 brain;ack 出站失败不阻断慢机", async () => {
    deps.triage.triage.mockResolvedValue({ action: "escalate", brief: "选型", ack: "收到,我看看哈" });
    const order = [];
    deps.outbound.sendMessage.mockImplementation(async ({ text }) => { order.push(`send:${text}`); return { messageId: "om_a" }; });
    deps.brain.turn.mockImplementation(async () => { order.push("brain"); return { finalText: "结论", events: [] }; });
    await handler.handleTurn({ kind: "message", session, sessionKey: "feishu:p2p:ou_a", items, mode: "addressed" });
    expect(order).toEqual(["send:收到,我看看哈", "brain", expect.stringContaining("send:这次处理没能")]);
    const rows = store.transcript(session.id).map((m) => `${m.role}:${m.content}`);
    expect(rows.some((r) => r.startsWith("assistant:收到,我看看哈"))).toBe(true);

    // ack 失败不阻断
    deps.outbound.sendMessage.mockRejectedValueOnce(new Error("boom"));
    deps.brain.turn.mockClear();
    await handler.handleTurn({ kind: "message", session, sessionKey: "feishu:p2p:ou_a", items, mode: "addressed" });
    expect(deps.brain.turn).toHaveBeenCalledTimes(1);
  });

  it("escalate 无 ack(steer 转 escalate 等):直接进 brain,无正式 reply 时 daemon 收口", async () => {
    deps.triage.triage.mockResolvedValue({ action: "escalate", brief: "选型" });
    await handler.handleTurn({ kind: "message", session, sessionKey: "feishu:p2p:ou_a", items, mode: "addressed" });
    expect(deps.outbound.sendMessage).toHaveBeenCalledTimes(1);
    expect(deps.outbound.sendMessage).toHaveBeenCalledWith(expect.objectContaining({ text: expect.stringContaining("没能生成") }));
    expect(deps.brain.turn).toHaveBeenCalledTimes(1);
  });
});

// 2026-07-14 真机事故回归:"测试消息"被快机误 escalate→慢机空转→daemon fallback 出站。
// 全链断言:真 createTriage(mock 快机 caller)接入 turn-handler,轻交互零慢机调用。
describe("轻交互零慢机调用(全链回归)", () => {
  let db, store, session, deps, events;
  const mkHandler = (fastPayload) => {
    db = openDb();
    migrate(db);
    store = createSessionStore(db);
    session = store.getOrCreate("feishu:p2p:ou_a", { kind: "p2p" });
    events = [];
    deps = {
      triage: createTriage({ caller: { call: vi.fn(async () => ({ text: fastPayload, model: "v4-flash" })) }, store }),
      brain: { turn: vi.fn(async () => ({ finalText: "内部结论", events: [] })), steer: vi.fn(), isBusy: () => false },
      renderReply: vi.fn(async () => ({ text: "渲染稿", usage: null })),
      outbound: { sendMessage: vi.fn(async () => ({ messageId: "om_9" })), sendCard: vi.fn(async () => ({ messageId: "om_card_9" })), editMessage: vi.fn() },
      store,
      budget: { allow: vi.fn(() => ({ ok: true })), record: vi.fn() },
      grants: createDeliverGrants(),
      onEvent: (e) => events.push(e),
    };
    return createTurnHandler(deps);
  };
  const turn = (content) => ({
    kind: "message", session, sessionKey: "feishu:p2p:ou_a",
    items: [{ content, senderOpenId: "ou_a", senderName: "张三", ts: 1000 }], mode: "addressed",
  });

  it('"测试消息"+快机误 escalate:只出一条回复,零 brain 调用,零 business turn,无 daemon fallback', async () => {
    const handler = mkHandler('{"action":"escalate","brief":"用户在测试","ack":"收到,我看看哈"}');
    await handler.handleTurn(turn("测试消息"));
    expect(deps.brain.turn).not.toHaveBeenCalled();
    expect(deps.outbound.sendMessage).toHaveBeenCalledTimes(1);
    const sent = deps.outbound.sendMessage.mock.calls[0][0].text;
    expect(sent).not.toBe(DAEMON_TERMINAL_FALLBACK);
    expect(sent).not.toContain("我看看");                        // ack 不当终态回复
    expect(events.some((e) => e.type === "business_turn_admitted")).toBe(false);
    expect(events.find((e) => e.type === "triage")?.guard).toBe("light_interaction");
    expect(store.transcript(session.id).map((m) => m.role)).toEqual(["user", "assistant"]);
  });

  it('"测试一下删除任务":写意图照常进慢机,brain.turn=1', async () => {
    const handler = mkHandler('{"action":"quick_reply","text":"好的"}');   // 快机再想直回也拦
    await handler.handleTurn(turn("测试一下删除任务"));
    expect(deps.brain.turn).toHaveBeenCalledTimes(1);
    expect(events.some((e) => e.type === "business_turn_admitted")).toBe(true);
  });

  it('"帮我查一下会议记录":正常升级慢机不受反向护栏影响', async () => {
    const handler = mkHandler('{"action":"escalate","brief":"查会议记录","ack":"我查下哈"}');
    await handler.handleTurn(turn("帮我查一下会议记录"));
    expect(deps.brain.turn).toHaveBeenCalledTimes(1);
  });
});

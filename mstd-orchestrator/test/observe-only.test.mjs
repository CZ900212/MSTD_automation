import { describe, it, expect, vi, beforeEach } from "vitest";
import { openDb, migrate } from "../server/db/index.mjs";
import { createAdmit } from "../server/gateway/admit.mjs";
import { createSessionStore } from "../server/sessions/store.mjs";
import { createTurnHandler } from "../server/gateway/turn-handler.mjs";
import { createObserveReport } from "../server/gateway/observe-report.mjs";
import { wireGateway } from "../server/gateway/wire.mjs";

describe("观察期模式（observe_only）", () => {
  let db, store, session, deps, handler;
  beforeEach(() => {
    db = openDb();
    migrate(db);
    store = createSessionStore(db);
    session = store.getOrCreate("feishu:group:oc_obs", { kind: "group", chatId: "oc_obs" });
    deps = {
      triage: { triage: vi.fn(async () => ({ action: "quick_reply", text: "我会这么说" })) },
      brain: { turn: vi.fn(async () => ({ finalText: "", events: [] })), steer: vi.fn(), isBusy: () => false },
      renderReply: vi.fn(),
      outbound: { sendMessage: vi.fn() },
      store,
      budget: { allow: () => ({ ok: true }), record: vi.fn() },
      db,
    };
    handler = createTurnHandler(deps);
  });

  it("admit：observe_only 策略放行为 observe_only 模式", () => {
    db.prepare("INSERT INTO group_policies (chat_id, policy, hourly_proactive_limit, updated_at) VALUES ('oc_obs','observe_only',4,0)").run();
    const admit = createAdmit(db, { botOpenId: "ou_bot" });
    const v = admit.admit({ kind: "message", chatType: "group", chatId: "oc_obs", senderOpenId: "ou_a", content: "求助", mentionsBot: false });
    expect(v).toEqual({ ok: true, mode: "observe_only" });
    // @ 也不例外（观察期一律不出站，但判定照跑）
    const v2 = admit.admit({ kind: "message", chatType: "group", chatId: "oc_obs", senderOpenId: "ou_a", content: "@bot 在吗", mentionsBot: true });
    expect(v2).toEqual({ ok: true, mode: "observe_only" });
  });

  // 曾经的假绿：直接手工注入 mode 绕过 wire，掩盖了 flush 把 observe_only 折叠成 ambient
  // 的回归（b9eb7e1）。现走 ingestRaw 真实管道（inbox→admit→debounce→handleTurn）验证。
  it("真实管道（legacy）：门控照跑、拟发言落 observe_log，但 outbound 零调用", async () => {
    vi.useFakeTimers();
    db.prepare("INSERT INTO group_policies (chat_id, policy, hourly_proactive_limit, updated_at) VALUES ('oc_obs','observe_only',4,0)").run();
    const wired = wireGateway({
      db,
      config: { botOpenId: "ou_bot", larkCliPath: "/fake" },
      handleTurn: handler.handleTurn,
      actors: { enqueue: (_key, callback) => callback() },
      startConsumer: false,
    });
    const res = wired.ingestRaw({
      type: "im.message.receive_v1", event_id: "obs-e1",
      chat_id: "oc_obs", chat_type: "group", message_type: "text",
      sender_id: "ou_a", sender_name: "同事", content: "报销流程谁知道", create_time: "1000",
    });
    expect(res).toMatchObject({ accepted: true, mode: "observe_only" });
    await vi.advanceTimersByTimeAsync(4000);

    expect(deps.triage.triage).toHaveBeenCalledWith(expect.objectContaining({ mode: "observe_only" })); // 判定跑了
    expect(deps.outbound.sendMessage).not.toHaveBeenCalled();    // 不出站
    expect(deps.brain.turn).not.toHaveBeenCalled();              // 不进中枢（省钱）
    const logRow = db.prepare("SELECT * FROM observe_log WHERE chat_id = 'oc_obs'").get();
    expect(logRow.action).toBe("quick_reply");
    expect(logRow.text).toContain("我会这么说");
    expect(store.transcript(session.id)[0].observed).toBe(1);    // 消息仍进上下文
    vi.useRealTimers();
  });

  it("真实管道（active）：应答机照常判定但零出站、不建 dispatch、不进调度器", async () => {
    vi.useFakeTimers();
    db.prepare("INSERT INTO group_policies (chat_id, policy, hourly_proactive_limit, updated_at) VALUES ('oc_obs','observe_only',4,0)").run();
    const responder = { answerTurn: vi.fn(async () => ({ action: "reply", text: "我会这么答" })) };
    const taskStore = { createDispatch: vi.fn(), recordDispatchSent: vi.fn() };
    const coordinator = { schedule: vi.fn() };
    const activeHandler = createTurnHandler({
      ...deps, architectureMode: "active", responder, taskStore, coordinator,
    });
    const wired = wireGateway({
      db,
      config: { botOpenId: "ou_bot", larkCliPath: "/fake", agentArchitectureMode: "active", agentActiveAll: true },
      handleTurn: activeHandler.handleTurn,
      actors: { enqueue: (_key, callback) => callback() },
      startConsumer: false,
    });
    wired.ingestRaw({
      type: "im.message.receive_v1", event_id: "obs-e2",
      chat_id: "oc_obs", chat_type: "group", message_type: "text",
      sender_id: "ou_a", sender_name: "同事", content: "这个报销走哪个流程？", create_time: "2000",
    });
    await vi.advanceTimersByTimeAsync(4000);

    expect(responder.answerTurn).toHaveBeenCalledWith(expect.objectContaining({ mode: "observe_only" }));
    expect(deps.outbound.sendMessage).not.toHaveBeenCalled();
    expect(taskStore.createDispatch).not.toHaveBeenCalled();
    expect(coordinator.schedule).not.toHaveBeenCalled();
    const logRow = db.prepare("SELECT * FROM observe_log WHERE chat_id = 'oc_obs'").get();
    expect(logRow.action).toBe("reply");
    expect(logRow.text).toContain("我会这么答");
    expect(store.transcript(session.id)[0].observed).toBe(1);
    vi.useRealTimers();
  });

  it("周报统计：信号/噪声比 DM 管理员", async () => {
    const ins = db.prepare("INSERT INTO observe_log (id, chat_id, action, text, ts) VALUES (?, 'oc_obs', ?, ?, ?)");
    ins.run("1", "quick_reply", "答A", 1000);
    ins.run("2", "no_reply", null, 2000);
    ins.run("3", "no_reply", null, 3000);
    ins.run("4", "escalate", "深度回答B", 4000);
    const deliverSystemText = vi.fn(async () => ({ messageId: "om_r" }));
    const report = createObserveReport({ db, deliverSystemText, adminOpenId: "ou_admin" });
    await report.sendWeekly(10_000);
    expect(deliverSystemText).toHaveBeenCalledWith(
      "feishu:p2p:ou_admin",
      expect.stringContaining("oc_obs"),
      expect.objectContaining({ idempotencyKey: expect.any(String) }),
    );
    expect(deliverSystemText.mock.calls[0][1]).toContain("2/4"); // 会发言 2 / 总 4
  });

  it("周报投递抛错：返回 ok:false（调用方据此不烧档期），下次 tick 用同样入参重发即可成功", async () => {
    const ins = db.prepare("INSERT INTO observe_log (id, chat_id, action, text, ts) VALUES (?, 'oc_obs', ?, ?, ?)");
    ins.run("1", "quick_reply", "答A", 1000);
    ins.run("2", "escalate", "深度回答B", 2000);
    const deliverSystemText = vi.fn(async () => { throw new Error("网关超时"); });
    const report = createObserveReport({ db, deliverSystemText, adminOpenId: "ou_admin", log: vi.fn() });

    const failed = await report.sendWeekly(10_000);
    expect(failed).toEqual({ ok: false, error: "网关超时" }); // 失败必须显式冒泡，不能吞成 ok:true

    deliverSystemText.mockImplementation(async () => ({ messageId: "om_retry" }));
    const retried = await report.sendWeekly(10_000); // 同一周档期重试
    expect(retried).toMatchObject({ ok: true, groups: 1 });
    expect(deliverSystemText).toHaveBeenCalledTimes(2);
  });
});

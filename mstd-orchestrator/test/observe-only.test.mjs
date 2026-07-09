import { describe, it, expect, vi, beforeEach } from "vitest";
import { openDb, migrate } from "../server/db/index.mjs";
import { createAdmit } from "../server/gateway/admit.mjs";
import { createSessionStore } from "../server/sessions/store.mjs";
import { createTurnHandler } from "../server/gateway/turn-handler.mjs";
import { createObserveReport } from "../server/gateway/observe-report.mjs";

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

  it("门控照跑（V4 判定执行、拟发言落库）但 outbound 零调用", async () => {
    await handler.handleTurn({
      kind: "message", session, sessionKey: "feishu:group:oc_obs",
      items: [{ content: "报销流程谁知道", senderOpenId: "ou_a", senderName: "同事", ts: 1000 }],
      mode: "observe_only",
    });
    expect(deps.triage.triage).toHaveBeenCalled();               // 判定跑了
    expect(deps.outbound.sendMessage).not.toHaveBeenCalled();    // 不出站
    expect(deps.brain.turn).not.toHaveBeenCalled();              // 不进中枢（省钱）
    const logRow = db.prepare("SELECT * FROM observe_log WHERE chat_id = 'oc_obs'").get();
    expect(logRow.action).toBe("quick_reply");
    expect(logRow.text).toContain("我会这么说");
    expect(store.transcript(session.id)[0].observed).toBe(1);    // 消息仍进上下文
  });

  it("周报统计：信号/噪声比 DM 管理员", async () => {
    const ins = db.prepare("INSERT INTO observe_log (id, chat_id, action, text, ts) VALUES (?, 'oc_obs', ?, ?, ?)");
    ins.run("1", "quick_reply", "答A", 1000);
    ins.run("2", "no_reply", null, 2000);
    ins.run("3", "no_reply", null, 3000);
    ins.run("4", "escalate", "深度回答B", 4000);
    const outbound = { sendMessage: vi.fn(async () => ({ messageId: "om_r" })) };
    const report = createObserveReport({ db, outbound, adminOpenId: "ou_admin" });
    await report.sendWeekly(10_000);
    const call = outbound.sendMessage.mock.calls[0][0];
    expect(call.openId).toBe("ou_admin");
    expect(call.text).toContain("oc_obs");
    expect(call.text).toContain("2/4");                          // 会发言 2 / 总 4
  });
});

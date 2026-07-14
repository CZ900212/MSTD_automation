import { describe, it, expect, beforeEach } from "vitest";
import { openDb, migrate } from "../server/db/index.mjs";
import { createAdmit } from "../server/gateway/admit.mjs";

const evt = (over = {}) => ({
  kind: "message", chatType: "group", chatId: "oc_1",
  senderOpenId: "ou_a", content: "在吗", mentionsBot: false, ...over,
});

describe("admit", () => {
  let db, admit;
  beforeEach(() => {
    db = openDb();
    migrate(db);
    admit = createAdmit(db, { botOpenId: "ou_bot" });
  });
  it("私聊直通 addressed", () => {
    expect(admit.admit(evt({ chatType: "p2p" }))).toEqual({ ok: true, mode: "addressed" });
  });
  it("bot 自己的消息拒绝 self_echo", () => {
    expect(admit.admit(evt({ senderOpenId: "ou_bot" }))).toEqual({ ok: false, reason: "self_echo" });
    // 真机形状：bot 消息 sender_type=app 且无 open_id
    expect(admit.admit(evt({ senderOpenId: null, senderType: "app" }))).toEqual({ ok: false, reason: "self_echo" });
  });

  it("simulator 白名单：仅启用+测试群+受信 app 放行；simulator 类型按 user 语义", () => {
    const sim = {
      enabled: true,
      chatIds: new Set(["oc_test"]),
      actors: new Map([["cli_sim_product", "lin_xi"]]),
    };
    const admitSim = createAdmit(db, { botOpenId: "ou_bot", simulator: sim });

    // 未知 app
    expect(admitSim.admit(evt({
      senderOpenId: null, senderType: "app", senderAppId: "cli_unknown", chatId: "oc_test", mentionsBot: true,
    }))).toEqual({ ok: false, reason: "self_echo" });

    // 白名单 app 但非测试群
    expect(admitSim.admit(evt({
      senderOpenId: null, senderType: "app", senderAppId: "cli_sim_product", chatId: "oc_other", mentionsBot: true,
    }))).toEqual({ ok: false, reason: "self_echo" });

    // 白名单 + 测试群 + @ → addressed
    expect(admitSim.admit(evt({
      senderOpenId: null, senderType: "app", senderAppId: "cli_sim_product", chatId: "oc_test", mentionsBot: true,
    }))).toEqual({ ok: true, mode: "addressed" });

    // 白名单 + 测试群 + 未 @ → observe
    expect(admitSim.admit(evt({
      senderOpenId: null, senderType: "app", senderAppId: "cli_sim_product", chatId: "oc_test", mentionsBot: false,
    }))).toEqual({ ok: false, reason: "bot_not_mentioned_observe" });

    // C 模式 senderType=simulator：@ 小达 → addressed
    expect(admitSim.admit(evt({
      senderOpenId: "sim_lin_xi", senderType: "simulator", chatId: "oc_test", mentionsBot: true, content: "@小达 在吗",
    }))).toEqual({ ok: true, mode: "addressed" });

    // C 模式未 @ → 按群 policy
    expect(admitSim.admit(evt({
      senderOpenId: "sim_zhou_yan", senderType: "simulator", chatId: "oc_test", mentionsBot: false,
    }))).toEqual({ ok: false, reason: "bot_not_mentioned_observe" });

    // simulator 类型但不在白名单群
    expect(admitSim.admit(evt({
      senderOpenId: "sim_lin_xi", senderType: "simulator", chatId: "oc_other", mentionsBot: true,
    }))).toEqual({ ok: false, reason: "simulator_chat_not_allowed" });
  });
  it("群默认 mention_only：@ 了 addressed，没 @ 存 observed", () => {
    expect(admit.admit(evt({ mentionsBot: true }))).toEqual({ ok: true, mode: "addressed" });
    expect(admit.admit(evt())).toEqual({ ok: false, reason: "bot_not_mentioned_observe" });
  });
  it("群策略 ambient：未 @ 也放行为 ambient；disabled 拒绝", () => {
    db.prepare("INSERT INTO group_policies (chat_id, policy, hourly_proactive_limit, updated_at) VALUES ('oc_1','ambient',4,0)").run();
    expect(admit.admit(evt())).toEqual({ ok: true, mode: "ambient" });
    db.prepare("UPDATE group_policies SET policy='disabled' WHERE chat_id='oc_1'").run();
    expect(admit.admit(evt())).toEqual({ ok: false, reason: "group_disabled" });
  });
});

import { describe, it, expect } from "vitest";
import { buildLarkReadArgsScoped, resolveLarkScope, READ_OP_NAMES } from "../server/safety/lark-read.mjs";

const GROUP = { kind: "group", chatId: "oc_aaa111" };
const P2P = { kind: "p2p", chatId: "oc_bbb222", openId: "ou_zhang" };
const P2P_OWNER = { kind: "p2p", chatId: "oc_ccc333", openId: "ou_owner", ownerOpenId: "ou_owner" };
const JOB = { kind: "job" };
const CRON = { kind: "cron" };

describe("resolveLarkScope（env → 调用域）", () => {
  it("群会话：chatId 从 sessionKey 解出", () => {
    expect(resolveLarkScope({ MSTD_SESSION_KEY: "feishu:group:oc_aaa111" }))
      .toMatchObject({ kind: "group", chatId: "oc_aaa111" });
    expect(resolveLarkScope({ MSTD_SESSION_KEY: "feishu:group:oc_aaa111:tp_1" }))
      .toMatchObject({ kind: "group", chatId: "oc_aaa111" });
  });

  it("私聊会话：openId 从 sessionKey、chatId 从 MSTD_CHAT_ID", () => {
    expect(resolveLarkScope({ MSTD_SESSION_KEY: "feishu:p2p:ou_zhang", MSTD_CHAT_ID: "oc_bbb222" }))
      .toMatchObject({ kind: "p2p", openId: "ou_zhang", chatId: "oc_bbb222" });
    expect(resolveLarkScope({ MSTD_SESSION_KEY: "feishu:p2p:ou_zhang" }).chatId).toBeNull();
  });

  it("owner 从 MSTD_OWNER_OPEN_ID 透传", () => {
    expect(resolveLarkScope({ MSTD_SESSION_KEY: "feishu:p2p:ou_o", MSTD_OWNER_OPEN_ID: "ou_o" }).ownerOpenId).toBe("ou_o");
  });

  it("job：无 sessionKey 但有 MSTD_JOB_WORKDIR", () => {
    expect(resolveLarkScope({ MSTD_JOB_WORKDIR: "/tmp/out/j1" })).toMatchObject({ kind: "job" });
  });

  it("cron/debug 会话原样传 kind", () => {
    expect(resolveLarkScope({ MSTD_SESSION_KEY: "cron:j1" })).toMatchObject({ kind: "cron" });
    expect(resolveLarkScope({ MSTD_SESSION_KEY: "debug:d1" })).toMatchObject({ kind: "debug" });
  });

  it("无身份/非法 sessionKey → unknown（fail-closed）", () => {
    expect(resolveLarkScope({})).toMatchObject({ kind: "unknown" });
    expect(resolveLarkScope({ MSTD_SESSION_KEY: "怪东西" })).toMatchObject({ kind: "unknown" });
  });
});

describe("聊天内容类：只许本会话", () => {
  it("群会话缺省即本群；显式同 chat_id 亦可", () => {
    const argv = buildLarkReadArgsScoped("chat_history", {}, GROUP);
    expect(argv).toContain("oc_aaa111");
    expect(buildLarkReadArgsScoped("chat_members", { chat_id: "oc_aaa111" }, GROUP)).toContain("oc_aaa111");
  });

  it("跨会话 chat_id 一律拒绝（群读别群/群读私聊）", () => {
    expect(() => buildLarkReadArgsScoped("chat_history", { chat_id: "oc_bbb222" }, GROUP)).toThrow(/跨会话/);
    expect(() => buildLarkReadArgsScoped("chat_members", { chat_id: "oc_ddd" }, GROUP)).toThrow(/跨会话/);
    expect(() => buildLarkReadArgsScoped("chat_history", { chat_id: "oc_aaa111" }, P2P)).toThrow(/跨会话/);
  });

  it("search_messages 强制圈定本会话，显式跨会话拒绝", () => {
    const argv = buildLarkReadArgsScoped("search_messages", { query: "预算" }, GROUP);
    expect(argv).toContain("--chat-id");
    expect(argv[argv.indexOf("--chat-id") + 1]).toBe("oc_aaa111");
    expect(() => buildLarkReadArgsScoped("search_messages", { query: "q", chat_id: "oc_bbb222" }, GROUP)).toThrow(/跨会话/);
  });

  it("私聊会话圈定在本私聊 chat_id", () => {
    const argv = buildLarkReadArgsScoped("search_messages", { query: "q" }, P2P);
    expect(argv[argv.indexOf("--chat-id") + 1]).toBe("oc_bbb222");
  });

  it("p2p 未绑定 chat_id → fail-closed 拒绝", () => {
    expect(() => buildLarkReadArgsScoped("chat_history", {}, { kind: "p2p", chatId: null, openId: "ou_x" }))
      .toThrow(/chat_id/);
  });

  it("job/cron/debug/unknown 域全拒聊天内容", () => {
    for (const scope of [JOB, CRON, { kind: "debug" }]) {
      expect(() => buildLarkReadArgsScoped("chat_history", { chat_id: "oc_aaa111" }, scope)).toThrow(/禁止读聊天内容/);
      expect(() => buildLarkReadArgsScoped("search_messages", { query: "q" }, scope)).toThrow(/禁止读聊天内容/);
    }
    expect(() => buildLarkReadArgsScoped("chat_history", { chat_id: "oc_a" }, { kind: "unknown" })).toThrow(/fail-closed/);
  });
});

describe("席位私有类：owner 私聊 + 妙记 job 例外", () => {
  it("群/普通私聊读邮件、妙记一律拒绝", () => {
    for (const scope of [GROUP, P2P, CRON]) {
      for (const op of ["mail_list", "search_minutes"]) {
        expect(() => buildLarkReadArgsScoped(op, {}, scope)).toThrow(/席位私有/);
      }
      expect(() => buildLarkReadArgsScoped("mail_message", { message_id: "m1" }, scope)).toThrow(/席位私有/);
      expect(() => buildLarkReadArgsScoped("get_transcript", { minute_token: "mt" }, scope)).toThrow(/席位私有/);
    }
  });

  it("owner 私聊放行全部席位私有 op", () => {
    expect(buildLarkReadArgsScoped("mail_list", {}, P2P_OWNER)[0]).toBe("mail");
    expect(buildLarkReadArgsScoped("search_minutes", {}, P2P_OWNER)[0]).toBe("minutes");
  });

  it("job 域保留妙记链两个 op，但邮件不放行", () => {
    expect(buildLarkReadArgsScoped("search_minutes", {}, JOB)[0]).toBe("minutes");
    expect(buildLarkReadArgsScoped("get_transcript", { minute_token: "mt" }, JOB)[0]).toBe("minutes");
    expect(() => buildLarkReadArgsScoped("mail_list", {}, JOB)).toThrow(/席位私有/);
  });

  it("未配置 owner 时（ownerOpenId 缺省）任何私聊都拒绝——fail-closed", () => {
    expect(() => buildLarkReadArgsScoped("mail_list", {}, { kind: "p2p", chatId: "oc_c", openId: "ou_owner" }))
      .toThrow(/席位私有/);
  });
});

describe("元数据与公司资产类", () => {
  it("群/私聊/cron 可列群、搜群（只有名字没有内容）", () => {
    for (const scope of [GROUP, P2P, CRON]) {
      expect(buildLarkReadArgsScoped("list_chats", {}, scope)[0]).toBe("im");
      expect(buildLarkReadArgsScoped("search_chats", { query: "销售" }, scope)[0]).toBe("im");
    }
  });

  it("job 域不给元数据，公司资产也只留妙记链窄集", () => {
    expect(() => buildLarkReadArgsScoped("list_chats", {}, JOB)).toThrow(/后台任务/);
    expect(() => buildLarkReadArgsScoped("read_doc", { doc: "d" }, JOB)).toThrow(/后台任务/);
    expect(buildLarkReadArgsScoped("search_user", { query: "张三" }, JOB)[0]).toBe("contact");
    expect(buildLarkReadArgsScoped("get_user", {}, JOB)[0]).toBe("contact");
  });

  it("公司资产类在群/私聊/cron 维持现状放行", () => {
    for (const scope of [GROUP, P2P, CRON]) {
      expect(buildLarkReadArgsScoped("read_doc", { doc: "https://x.feishu.cn/docx/A" }, scope)[0]).toBe("docs");
      expect(buildLarkReadArgsScoped("agenda", {}, scope)[0]).toBe("calendar");
      expect(buildLarkReadArgsScoped("my_tasks", {}, scope)[0]).toBe("task");
    }
  });

  it("unknown 域对全部 op fail-closed", () => {
    const fill = {
      minute_token: "m", query: "q", chat_id: "oc_abc", doc: "d", space_id: "s", node_token: "n",
      spreadsheet_token: "st", sheet_id: "si", range: "A1:B2", base_token: "bt", table_id: "ti",
      user_id: "ou_abc", message_id: "mi", date_from: 20260701, date_to: 20260712,
    };
    for (const op of READ_OP_NAMES) {
      const params = op === "attendance" ? { user_id: "e1", date_from: 20260701, date_to: 20260712 } : fill;
      expect(() => buildLarkReadArgsScoped(op, params, { kind: "unknown" })).toThrow(/fail-closed/);
      expect(() => buildLarkReadArgsScoped(op, params, undefined)).toThrow(/fail-closed/);
    }
  });

  it("未知 op 依旧 deny-by-default（门禁不放大白名单）", () => {
    expect(() => buildLarkReadArgsScoped("delete_everything", {}, GROUP)).toThrow(/不允许/);
  });
});

// 红队 T4：会话域门禁的信任根 = Pi 子进程环境变量。
// 本文件分两部分：
//  A. 污染即绕过（单测层证据）：env 被污染的四种途径各自完全击穿门禁。
//     这些用例断言"当前行为"——它们通过 = 洞在信任假设层面存在。
//  B. 真机可达性控制（防线符合预期面）：buildPiEnv 白名单过滤 + 生产注入点全部
//     使用服务端权威值（brain.mjs:209 session.chat_id / orchestrator.mjs:53-54 readPrincipal /
//     index.mjs:299 config）——daemon env 的 MSTD_* 默认不泄入子进程。
// 结论：门禁逻辑本身正确，其安全性 ≡ env 完整性；可达性低，残留为设计边界（见报告 T4 节）。
import { describe, it, expect } from "vitest";
import { buildLarkReadArgsScoped, resolveLarkScope } from "../server/safety/lark-read.mjs";
import { buildPiEnv } from "../server/pi/rpc-protocol.mjs";

describe("T4-A 环境污染即绕过（信任假设的单测层证据）", () => {
  it("污染 MSTD_CHAT_ID：p2p 会话越权读任意群聊天内容", () => {
    // 攻击者私聊 ou_evil；若 MSTD_CHAT_ID 被写成受害群 oc_ff00aa，
    // 门禁把 oc_ff00aa 当"本会话"，chat_history/search_messages 全部放行
    const scope = resolveLarkScope({ MSTD_SESSION_KEY: "feishu:p2p:ou_evil", MSTD_CHAT_ID: "oc_ff00aa" });
    expect(scope).toMatchObject({ kind: "p2p", openId: "ou_evil", chatId: "oc_ff00aa" });
    const argv = buildLarkReadArgsScoped("chat_history", { chat_id: "oc_ff00aa" }, scope);
    expect(argv).toContain("oc_ff00aa");
    // 对照：chatId 是真实私聊时，读 oc_ff00aa 被拒
    const legit = resolveLarkScope({ MSTD_SESSION_KEY: "feishu:p2p:ou_evil", MSTD_CHAT_ID: "oc_00aa11" });
    expect(() => buildLarkReadArgsScoped("chat_history", { chat_id: "oc_ff00aa" }, legit)).toThrow(/跨会话/);
  });

  it("污染 MSTD_PRIVATE_DATA_OWNER_OPEN_ID：任意私聊秒变 owner，邮件/妙记全放", () => {
    const scope = resolveLarkScope({
      MSTD_SESSION_KEY: "feishu:p2p:ou_evil",
      MSTD_CHAT_ID: "oc_0a0a0a",
      MSTD_PRIVATE_DATA_OWNER_OPEN_ID: "ou_evil",
    });
    expect(buildLarkReadArgsScoped("mail_list", {}, scope)[0]).toBe("mail");
    expect(buildLarkReadArgsScoped("search_minutes", {}, scope)[0]).toBe("minutes");
    expect(buildLarkReadArgsScoped("get_transcript", { minute_token: "mt" }, scope)[0]).toBe("minutes");
    // 对照：owner 不匹配时全拒
    const legit = resolveLarkScope({
      MSTD_SESSION_KEY: "feishu:p2p:ou_evil",
      MSTD_CHAT_ID: "oc_0a0a0a",
      MSTD_PRIVATE_DATA_OWNER_OPEN_ID: "ou_realowner",
    });
    expect(() => buildLarkReadArgsScoped("mail_list", {}, legit)).toThrow(/席位私有/);
  });

  it("污染 MSTD_JOB_PRIVATE_READ_AUTHORIZED=1：job 域读到席位私有妙记", () => {
    const forged = resolveLarkScope({ MSTD_JOB_WORKDIR: "/tmp/out/j1", MSTD_JOB_PRIVATE_READ_AUTHORIZED: "1" });
    expect(buildLarkReadArgsScoped("search_minutes", {}, forged)[0]).toBe("minutes");
    expect(buildLarkReadArgsScoped("get_transcript", { minute_token: "mt" }, forged)[0]).toBe("minutes");
    // 对照：生产注入的 "0"（orchestrator.mjs:54 privateDataAuthorized!==true 时）全拒
    const legit = resolveLarkScope({ MSTD_JOB_WORKDIR: "/tmp/out/j1", MSTD_JOB_PRIVATE_READ_AUTHORIZED: "0" });
    expect(() => buildLarkReadArgsScoped("search_minutes", {}, legit)).toThrow(/席位私有/);
  });

  it("污染 MSTD_SESSION_KEY 本身：门禁的全部信任根（群域直接易主）", () => {
    const scope = resolveLarkScope({ MSTD_SESSION_KEY: "feishu:group:oc_ff00aa" });
    expect(buildLarkReadArgsScoped("chat_history", { chat_id: "oc_ff00aa" }, scope)).toContain("oc_ff00aa");
  });

  it("优先级陷阱：job 进程一旦带 MSTD_SESSION_KEY 即整体逃逸 job 窄集（当前语义固定）", () => {
    // resolveLarkScope 先查 sessionKey 再查 jobWorkdir——
    // 任何未来改动若给 job spawn 误加 MSTD_SESSION_KEY，job 域收窄（JOB_OPS）将静默失效
    const scope = resolveLarkScope({
      MSTD_JOB_WORKDIR: "/tmp/out/j1",
      MSTD_SESSION_KEY: "feishu:group:oc_ff00aa",
    });
    expect(scope.kind).toBe("group"); // 不再是 job！
    expect(buildLarkReadArgsScoped("read_doc", { doc: "d" }, scope)[0]).toBe("docs");   // job 域本拒
    expect(buildLarkReadArgsScoped("list_chats", {}, scope)[0]).toBe("im");             // job 域本拒
    expect(buildLarkReadArgsScoped("chat_history", {}, scope)).toContain("oc_ff00aa");  // job 域本拒
  });
});

describe("T4-B 真机可达性控制（防线符合预期面）", () => {
  it("buildPiEnv 白名单：daemon 的 MSTD_* 默认不进子进程（scope 变量不随 env 泄漏）", () => {
    const daemonEnv = {
      PATH: "/usr/bin",
      MSTD_PRIVATE_DATA_OWNER_OPEN_ID: "ou_owner",
      MSTD_SESSION_KEY: "feishu:group:oc_dae000",
      MSTD_JOB_PRIVATE_READ_AUTHORIZED: "1",
      LARK_PROFILE: "prod",
      CZ_GPT_KEY: "k",
      HOME: "/home/x",
    };
    const child = buildPiEnv(daemonEnv, { MSTD_JOB_WORKDIR: "/tmp/out/j1" });
    expect(child.MSTD_PRIVATE_DATA_OWNER_OPEN_ID).toBeUndefined();
    expect(child.MSTD_SESSION_KEY).toBeUndefined();
    expect(child.MSTD_JOB_PRIVATE_READ_AUTHORIZED).toBeUndefined();
    expect(child.MSTD_JOB_WORKDIR).toBe("/tmp/out/j1"); // 显式 override 才进
    expect(child.LARK_PROFILE).toBe("prod");            // LARK_/PI_ 前缀放行（设计如此）
    expect(child.PATH).toBe("/usr/bin");
  });

  it("生产形状回放：job spawn（orchestrator）不给 sessionKey → 门禁停在 job 域", () => {
    // orchestrator.mjs:51-55 的实际 env 形状（无 MSTD_SESSION_KEY、无 owner）
    const scope = resolveLarkScope({
      MSTD_JOB_WORKDIR: "/tmp/out/j1",
      MSTD_JOB_REQUESTER_OPEN_ID: "ou_req",
      MSTD_JOB_PRIVATE_READ_AUTHORIZED: "0",
    });
    expect(scope.kind).toBe("job");
    expect(() => buildLarkReadArgsScoped("chat_history", {}, scope)).toThrow(/禁止读聊天内容/);
    expect(() => buildLarkReadArgsScoped("read_doc", { doc: "d" }, scope)).toThrow(/后台任务/);
  });
});

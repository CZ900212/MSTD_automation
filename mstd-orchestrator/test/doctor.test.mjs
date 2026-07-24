import { describe, it, expect } from "vitest";
import {
  findEmptyAssignments,
  checkEnvFile,
  checkLarkCliPath,
  checkPiEnvLarkCli,
  checkLarkAuth,
  checkAlertOpenId,
  checkSoul,
  checkNeedsAttention,
  checkArchitecture,
  checkSwitches,
} from "../server/health/doctor.mjs";

const yes = () => true;
const no = () => false;
const okExec = () => {};              // accessSync 不抛 = 可执行
const notExec = () => { throw new Error("EACCES"); };

describe("findEmptyAssignments", () => {
  it("命中活跃空赋值，忽略注释与有值行", () => {
    const text = [
      "# comment",
      "MSTD_ENABLE_AGENT=",       // 空 → 命中
      "PORT=8787",                // 有值
      "  LARK_PROFILE=  ",        // 纯空白 → 命中
      "# MSTD_LARK_CLI=",         // 注释 → 忽略
      "export FOO=",              // export 空 → 命中
      "",
    ].join("\n");
    expect(findEmptyAssignments(text)).toEqual(["MSTD_ENABLE_AGENT", "LARK_PROFILE", "FOO"]);
  });
});

describe("checkEnvFile", () => {
  it("文件不存在 → 红", () => {
    const r = checkEnvFile("/x/.env", { existsSync: no });
    expect(r.status).toBe("red");
  });
  it("有空赋值 → 红并列出 KEY", () => {
    const r = checkEnvFile("/x/.env", { existsSync: yes, readFileSync: () => "MSTD_ENABLE_AGENT=\n" });
    expect(r.status).toBe("red");
    expect(r.detail).toMatch(/MSTD_ENABLE_AGENT/);
  });
  it("干净 → 绿", () => {
    const r = checkEnvFile("/x/.env", { existsSync: yes, readFileSync: () => "PORT=8787\n# c\n" });
    expect(r.status).toBe("green");
  });
});

describe("checkLarkCliPath", () => {
  it("存在且可执行 → 绿，回显来源", () => {
    const r = checkLarkCliPath({ MSTD_LARK_CLI: "/opt/lark-cli" }, { existsSync: yes, accessSync: okExec });
    expect(r.status).toBe("green");
    expect(r.detail).toMatch(/MSTD_LARK_CLI/);
  });
  it("不存在 → 红", () => {
    const r = checkLarkCliPath({ LARK_CLI_BIN: "/nope" }, { existsSync: no, accessSync: okExec });
    expect(r.status).toBe("red");
  });
  it("存在但不可执行 → 红", () => {
    const r = checkLarkCliPath({ LARK_CLI_BIN: "/x" }, { existsSync: yes, accessSync: notExec });
    expect(r.status).toBe("red");
  });
});

describe("checkPiEnvLarkCli（事故核心检测点）", () => {
  it("守护配 MSTD_LARK_CLI → Pi env 下经桥接可解析 → 绿", () => {
    const r = checkPiEnvLarkCli({ MSTD_LARK_CLI: "/opt/lark-cli" }, { existsSync: yes, accessSync: okExec });
    expect(r.status).toBe("green");
    expect(r.detail).toMatch(/LARK_CLI_BIN 已传导/);
  });
  it("Pi 内解析到的路径不存在 → 红（正是妙记建任务静默失败的现场）", () => {
    const r = checkPiEnvLarkCli({}, { existsSync: no, accessSync: okExec });
    expect(r.status).toBe("red");
    expect(r.detail).toMatch(/回落 hermes 默认/);
  });
});

describe("checkLarkAuth", () => {
  it("无 LARK_PROFILE → 黄跳过", async () => {
    const r = await checkLarkAuth({}, { runLark: async () => ({}) });
    expect(r.status).toBe("yellow");
  });
  it("auth 正常 → 绿", async () => {
    const r = await checkLarkAuth({ LARK_PROFILE: "p" }, { runLark: async () => ({ exitCode: 0, stdout: "ok", stderr: "" }) });
    expect(r.status).toBe("green");
  });
  it("token 过期 → 红", async () => {
    const r = await checkLarkAuth({ LARK_PROFILE: "p" }, { runLark: async () => ({ exitCode: 0, stdout: "token expired", stderr: "" }) });
    expect(r.status).toBe("red");
  });
  it("lark-cli 不可用（runLark 缺失）→ 红", async () => {
    const r = await checkLarkAuth({ LARK_PROFILE: "p" }, {});
    expect(r.status).toBe("red");
  });
});

describe("checkAlertOpenId", () => {
  it("已配 → 绿", () => {
    expect(checkAlertOpenId({ MSTD_ALERT_OPEN_ID: "ou_x" }).status).toBe("green");
  });
  it("未配 → 黄", () => {
    expect(checkAlertOpenId({}).status).toBe("yellow");
  });
});

describe("checkSoul", () => {
  it("存在且非空 → 绿", () => {
    const r = checkSoul({}, "/root", { existsSync: yes, statSync: () => ({ size: 42 }) });
    expect(r.status).toBe("green");
  });
  it("缺失 → 红", () => {
    const r = checkSoul({}, "/root", { existsSync: no, statSync: () => ({ size: 0 }) });
    expect(r.status).toBe("red");
  });
  it("空文件 → 红", () => {
    const r = checkSoul({}, "/root", { existsSync: yes, statSync: () => ({ size: 0 }) });
    expect(r.status).toBe("red");
  });
  it("尊重 MSTD_MEMORY_DIR", () => {
    let seen;
    checkSoul({ MSTD_MEMORY_DIR: "/mem" }, "/root", { existsSync: (p) => { seen = p; return true; }, statSync: () => ({ size: 1 }) });
    expect(seen).toBe("/mem/SOUL.md");
  });
});

describe("checkNeedsAttention", () => {
  it("DB 打不开 → 黄降级不崩", () => {
    const r = checkNeedsAttention("/x.db", { openReadonlyDb: () => { throw new Error("no file"); }, countNeedsAttention: () => 0 });
    expect(r.status).toBe("yellow");
  });
  it("有积压 → 红", () => {
    const db = { close: () => {} };
    const r = checkNeedsAttention("/x.db", { openReadonlyDb: () => db, countNeedsAttention: () => 3 });
    expect(r.status).toBe("red");
    expect(r.detail).toMatch(/3 个/);
  });
  it("零积压 → 绿", () => {
    const db = { close: () => {} };
    const r = checkNeedsAttention("/x.db", { openReadonlyDb: () => db, countNeedsAttention: () => 0 });
    expect(r.status).toBe("green");
  });
});

describe("checkArchitecture", () => {
  it("legacy 默认 → 绿", () => {
    const r = checkArchitecture({});
    expect(r.status).toBe("green");
    expect(r.detail).toMatch(/mode=legacy/);
  });
  it("active + ACTIVE_ALL=1 → 绿（全量）", () => {
    const r = checkArchitecture({ MSTD_AGENT_ARCHITECTURE_MODE: "active", MSTD_AGENT_ACTIVE_ALL: "1" });
    expect(r.status).toBe("green");
    expect(r.detail).toMatch(/全量/);
  });
  it("active + 灰度 targets → 绿", () => {
    const r = checkArchitecture({
      MSTD_AGENT_ARCHITECTURE_MODE: "active",
      MSTD_AGENT_ACTIVE_TARGETS: "feishu:p2p:ou_abc123",
    });
    expect(r.status).toBe("green");
    expect(r.detail).toMatch(/灰度 1 个/);
  });
  it("active 但 ALL=0 且无 targets → 红（2026-07-22 崩溃循环现场）", () => {
    const r = checkArchitecture({ MSTD_AGENT_ARCHITECTURE_MODE: "active", MSTD_AGENT_ACTIVE_ALL: "0" });
    expect(r.status).toBe("red");
    expect(r.detail).toMatch(/崩溃循环/);
  });
  it("非法模式值 → 红", () => {
    const r = checkArchitecture({ MSTD_AGENT_ARCHITECTURE_MODE: "banana" });
    expect(r.status).toBe("red");
  });
  it("非法 target session key → 红", () => {
    const r = checkArchitecture({
      MSTD_AGENT_ARCHITECTURE_MODE: "active",
      MSTD_AGENT_ACTIVE_TARGETS: "not-a-session-key",
    });
    expect(r.status).toBe("red");
  });
});

describe("checkSwitches", () => {
  it("回显五个关键开关，未设显示 (未设)", () => {
    const r = checkSwitches({ MSTD_ENABLE_AGENT: "1" });
    expect(r.status).toBe("green");
    expect(r.detail).toMatch(/MSTD_ENABLE_AGENT=1/);
    expect(r.detail).toMatch(/MSTD_ENABLE_WRITE=\(未设\)/);
    expect(r.detail).toMatch(/MSTD_AGENT_ARCHITECTURE_MODE=\(未设\)/);
  });
});

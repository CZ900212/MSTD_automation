import { describe, it, expect } from "vitest";
import { parseRpcLine, isTerminalEvent, buildPiEnv } from "../server/pi/rpc-protocol.mjs";

describe("parseRpcLine", () => {
  it("parses a valid line and strips trailing CR", () => {
    const r = parseRpcLine('{"type":"agent_start"}\r');
    expect(r.ok).toBe(true);
    expect(r.msg.type).toBe("agent_start");
  });
  it("flags empty lines", () => {
    expect(parseRpcLine("   ").ok).toBe(false);
    expect(parseRpcLine("   ").kind).toBe("empty");
  });
  it("flags malformed JSON as parse_error (not silently dropped)", () => {
    const r = parseRpcLine("this is not json");
    expect(r.ok).toBe(false);
    expect(r.kind).toBe("parse_error");
    expect(r.raw).toBe("this is not json");
  });
});

describe("isTerminalEvent", () => {
  it("agent_end with willRetry false is terminal", () => {
    expect(isTerminalEvent({ type: "agent_end", willRetry: false })).toBe(true);
  });
  it("agent_end with willRetry true is NOT terminal", () => {
    expect(isTerminalEvent({ type: "agent_end", willRetry: true })).toBe(false);
  });
  it("phantom idle/agent_idle are NOT terminal", () => {
    expect(isTerminalEvent({ type: "agent_idle" })).toBe(false);
    expect(isTerminalEvent({ type: "idle" })).toBe(false);
  });
});

describe("buildPiEnv", () => {
  it("keeps allowlisted keys + PI_*, drops secrets, applies overrides", () => {
    const base = { PATH: "/bin", HOME: "/h", CZ_GPT_KEY: "g", LARK_PROFILE: "p", PI_TELEMETRY: "x", AWS_SECRET_ACCESS_KEY: "leak", RANDOM: "no" };
    const env = buildPiEnv(base, { PI_TELEMETRY: "0", LARK_ALLOW_WRITE: "1" });
    expect(env.PATH).toBe("/bin");
    expect(env.CZ_GPT_KEY).toBe("g");
    expect(env.LARK_PROFILE).toBe("p");
    expect(env.PI_TELEMETRY).toBe("0");
    expect(env.LARK_ALLOW_WRITE).toBe("1");
    expect(env.AWS_SECRET_ACCESS_KEY).toBeUndefined();
    expect(env.RANDOM).toBeUndefined();
  });

  it("桥接 MSTD_LARK_CLI → LARK_CLI_BIN（守护侧变量传导进 Pi；2026-07-22 事故治本）", () => {
    const env = buildPiEnv({ PATH: "/bin", MSTD_LARK_CLI: "/opt/lark/bin/lark-cli" });
    expect(env.LARK_CLI_BIN).toBe("/opt/lark/bin/lark-cli");
    // 原 MSTD_ 变量本身仍不进子进程（白名单不放行）
    expect(env.MSTD_LARK_CLI).toBeUndefined();
  });

  it("显式 LARK_CLI_BIN 优先于 MSTD_LARK_CLI 桥接（不被覆盖）", () => {
    const env = buildPiEnv({ PATH: "/bin", LARK_CLI_BIN: "/explicit/lark-cli", MSTD_LARK_CLI: "/opt/lark-cli" });
    expect(env.LARK_CLI_BIN).toBe("/explicit/lark-cli");
  });

  it("overrides 里的 LARK_CLI_BIN 覆盖桥接值", () => {
    const env = buildPiEnv({ PATH: "/bin", MSTD_LARK_CLI: "/opt/lark-cli" }, { LARK_CLI_BIN: "/override/lark-cli" });
    expect(env.LARK_CLI_BIN).toBe("/override/lark-cli");
  });

  it("两者都未配时不凭空造 LARK_CLI_BIN", () => {
    const env = buildPiEnv({ PATH: "/bin" });
    expect(env.LARK_CLI_BIN).toBeUndefined();
  });
});

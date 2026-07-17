import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { loadServerConfig, resolveAgentArchitecture } from "../server/config.mjs";

describe("loadServerConfig", () => {
  it("结构锁：带默认值的枚举和整数 env 由通用 helper 解析", () => {
    const src = readFileSync(new URL("../server/config.mjs", import.meta.url), "utf8");
    expect(src).toMatch(/function enumEnv\(/);
    expect(src).toMatch(/function intEnv\(/);
  });

  it("aggregates env knobs with sane defaults", () => {
    const c = loadServerConfig({ MSTD_SESSION_SECRET: "s", PORT: "9000" });
    expect(c.port).toBe(9000);
    expect(c.sessionSecret).toBe("s");
    expect(c.sessionTtlSeconds).toBe(7 * 86400);
    expect(c.maxConcurrentPi).toBe(2);
    expect(c.enableWrite).toBe(false);
    expect(c.enableTrigger).toBe(false);
    expect(c.backfill).toBe(false);
    expect(c.alertOpenId).toBe("");
    expect(c.meetingTaskNotificationMode).toBe("card");
    expect(c.contextEnvelopeMode).toBe("enforce");
    expect(c.dreamingMode).toBe("shadow");
    expect(c.pi.provider).toBe("cz-gpt");
    expect(c.pi.model).toBe("gpt-5.6-sol");
    expect(c.feishu).toHaveProperty("authorizeUrl");
  });
  it("honors overrides", () => {
    const c = loadServerConfig({
      MSTD_SESSION_SECRET: "s",
      MSTD_MAX_CONCURRENT_PI: "3",
      MSTD_ENABLE_WRITE: "1",
      MSTD_ENABLE_TRIGGER: "1",
      MSTD_BACKFILL: "1",
      MSTD_ALERT_OPEN_ID: " ou_alert ",
      MSTD_MEETING_TASK_NOTIFICATION_MODE: "feishu_system",
      MSTD_CONTEXT_ENVELOPE_MODE: "shadow",
      PI_MODEL: "gpt-5.6-sol-mini",
    });
    expect(c.maxConcurrentPi).toBe(3);
    expect(c.enableWrite).toBe(true);
    expect(c.enableTrigger).toBe(true);
    expect(c.backfill).toBe(true);
    expect(c.alertOpenId).toBe("ou_alert");
    expect(c.meetingTaskNotificationMode).toBe("feishu_system");
    expect(c.contextEnvelopeMode).toBe("shadow");
    expect(c.pi.model).toBe("gpt-5.6-sol-mini");
    expect(c.dreamingMode).toBe("shadow");
  });

  it("rejects unknown meeting notification mode", () => {
    expect(() => loadServerConfig({
      MSTD_SESSION_SECRET: "s",
      MSTD_MEETING_TASK_NOTIFICATION_MODE: "both",
    })).toThrow(/MSTD_MEETING_TASK_NOTIFICATION_MODE/);
  });

  it.each(["Enforce", "disabled", "", " enforce "])("rejects unsafe context envelope mode %j", (mode) => {
    expect(() => loadServerConfig({
      MSTD_SESSION_SECRET: "s",
      MSTD_CONTEXT_ENVELOPE_MODE: mode,
    })).toThrow(/MSTD_CONTEXT_ENVELOPE_MODE/);
  });

  it.each(["", "0", "-1", "1.5", "abc", "Infinity"])(
    "rejects invalid context byte budget %j at the config boundary",
    (value) => {
      expect(() => loadServerConfig({
        MSTD_SESSION_SECRET: "s",
        MSTD_CONTEXT_BUDGET_BYTES: value,
      })).toThrow(/MSTD_CONTEXT_BUDGET_BYTES/);
    },
  );

  it("accepts a positive safe-integer context byte budget", () => {
    expect(loadServerConfig({
      MSTD_SESSION_SECRET: "s",
      MSTD_CONTEXT_BUDGET_BYTES: "8192",
    }).contextBudgetBytes).toBe(8192);
  });

  it("defaults agent architecture mode to legacy for migration safety", () => {
    const c = loadServerConfig({ MSTD_SESSION_SECRET: "s" });
    expect(c.agentArchitectureMode).toBe("legacy");
  });

  it.each(["legacy", "shadow"])("accepts architecture mode %j", (mode) => {
    expect(loadServerConfig({
      MSTD_SESSION_SECRET: "s",
      MSTD_AGENT_ARCHITECTURE_MODE: mode,
    }).agentArchitectureMode).toBe(mode);
  });

  it.each(["", "Legacy", "unknown", " shadow ", "0"])(
    "rejects unknown or blank architecture mode %j at startup",
    (mode) => {
      expect(() => loadServerConfig({
        MSTD_SESSION_SECRET: "s",
        MSTD_AGENT_ARCHITECTURE_MODE: mode,
      })).toThrow(/MSTD_AGENT_ARCHITECTURE_MODE/);
    },
  );

  it("requires an explicit global switch or a canonical non-empty active target allowlist", () => {
    expect(() => loadServerConfig({
      MSTD_SESSION_SECRET: "s",
      MSTD_AGENT_ARCHITECTURE_MODE: "active",
    })).toThrow(/ACTIVE_TARGETS/);
    expect(() => loadServerConfig({
      MSTD_SESSION_SECRET: "s",
      MSTD_AGENT_ARCHITECTURE_MODE: "active",
      MSTD_AGENT_ACTIVE_TARGETS: "not-canonical",
    })).toThrow(/ACTIVE_TARGETS/);
    expect(loadServerConfig({
      MSTD_SESSION_SECRET: "s",
      MSTD_AGENT_ARCHITECTURE_MODE: "active",
      MSTD_AGENT_ACTIVE_TARGETS: "feishu:p2p:ou_admin",
    }).agentActiveTargets).toEqual(new Set(["feishu:p2p:ou_admin"]));
    const global = loadServerConfig({
      MSTD_SESSION_SECRET: "s",
      MSTD_AGENT_ARCHITECTURE_MODE: "active",
      MSTD_AGENT_ACTIVE_ALL: "1",
    });
    expect(global.agentActiveAll).toBe(true);
    expect(global.agentActiveTargets).toEqual(new Set());
  });

  it("resolves legacy/shadow/active per canonical target in one process", () => {
    const options = {
      requestedMode: "active",
      activeTargets: new Set(["feishu:p2p:ou_active"]),
      shadowTargets: new Set(["feishu:p2p:ou_shadow"]),
    };
    expect(resolveAgentArchitecture({ ...options, sessionKey: "feishu:p2p:ou_active" }))
      .toMatchObject({ effectiveMode: "active", match: "active_target" });
    expect(resolveAgentArchitecture({ ...options, sessionKey: "feishu:p2p:ou_shadow" }))
      .toMatchObject({ effectiveMode: "shadow", match: "shadow_target" });
    expect(resolveAgentArchitecture({ ...options, sessionKey: "feishu:p2p:ou_legacy" }))
      .toMatchObject({ effectiveMode: "legacy", match: "default" });
    expect(resolveAgentArchitecture({ requestedMode: "shadow", sessionKey: "feishu:p2p:ou_any" }))
      .toMatchObject({ effectiveMode: "shadow", match: "global_shadow" });
    expect(resolveAgentArchitecture({
      requestedMode: "active",
      activeAll: true,
      sessionKey: "feishu:p2p:ou_any",
    })).toMatchObject({ effectiveMode: "active", match: "active_all" });
    expect(resolveAgentArchitecture({
      requestedMode: "active",
      activeAll: true,
      sessionKey: "not-canonical",
    })).toMatchObject({ effectiveMode: "legacy", match: "invalid_target" });
  });

  it("defaults dispatch context bounds to 20 lines and 8192 bytes", () => {
    const c = loadServerConfig({ MSTD_SESSION_SECRET: "s" });
    expect(c.dispatchContextLines).toBe(20);
    expect(c.dispatchContextBytes).toBe(8192);
  });

  it("honors dispatch context bound overrides", () => {
    const c = loadServerConfig({
      MSTD_SESSION_SECRET: "s",
      MSTD_DISPATCH_CONTEXT_LINES: "12",
      MSTD_DISPATCH_CONTEXT_BYTES: "4096",
    });
    expect(c.dispatchContextLines).toBe(12);
    expect(c.dispatchContextBytes).toBe(4096);
  });

  it.each(["", "0", "-1", "1.5", "abc", "Infinity"])(
    "rejects invalid dispatch context lines %j",
    (value) => {
      expect(() => loadServerConfig({
        MSTD_SESSION_SECRET: "s",
        MSTD_DISPATCH_CONTEXT_LINES: value,
      })).toThrow(/MSTD_DISPATCH_CONTEXT_LINES/);
    },
  );

  it.each(["", "0", "-1", "1.5", "abc", "Infinity"])(
    "rejects invalid dispatch context bytes %j",
    (value) => {
      expect(() => loadServerConfig({
        MSTD_SESSION_SECRET: "s",
        MSTD_DISPATCH_CONTEXT_BYTES: value,
      })).toThrow(/MSTD_DISPATCH_CONTEXT_BYTES/);
    },
  );

  it("数字旋钮统一 intEnv fail-fast:垃圾值启动即报错,不再静默变 NaN", () => {
    // 修复前:Number("abc")=NaN 且 NaN ?? 600 仍是 NaN,流进 debounce 定时器/预算判断
    for (const key of [
      "MSTD_DEBOUNCE_ADDRESSED_MS", "MSTD_DEBOUNCE_AMBIENT_MS", "MSTD_DEBOUNCE_MAX_MS",
      "MSTD_DAILY_TOKEN_BUDGET", "MSTD_SESSION_TOKEN_BUDGET", "PORT",
    ]) {
      expect(() => loadServerConfig({ MSTD_SESSION_SECRET: "s", [key]: "abc" }), key)
        .toThrow(new RegExp(key));
      expect(() => loadServerConfig({ MSTD_SESSION_SECRET: "s", [key]: "-1" }), key)
        .toThrow(new RegExp(key));
    }
    // 合法值照常解析;缺省走默认
    const c = loadServerConfig({ MSTD_SESSION_SECRET: "s", MSTD_DEBOUNCE_ADDRESSED_MS: "250" });
    expect(c.debounceAddressedMs).toBe(250);
    expect(c.debounceAmbientMs).toBe(1500);
    expect(c.dailyTokenBudget).toBe(2_000_000);
    // PORT=0 = OS 随机端口,合法(fail-fast 负例测试依赖)
    expect(loadServerConfig({ MSTD_SESSION_SECRET: "s", PORT: "0" }).port).toBe(0);
  });

  it("defaults max reasoners per session to 3 and rejects unsafe values", () => {
    expect(loadServerConfig({ MSTD_SESSION_SECRET: "s" }).maxReasonersPerSession).toBe(3);
    expect(loadServerConfig({
      MSTD_SESSION_SECRET: "s",
      MSTD_MAX_REASONERS_PER_SESSION: "5",
    }).maxReasonersPerSession).toBe(5);
    expect(() => loadServerConfig({
      MSTD_SESSION_SECRET: "s",
      MSTD_MAX_REASONERS_PER_SESSION: "0",
    })).toThrow(/MSTD_MAX_REASONERS_PER_SESSION/);
  });
});

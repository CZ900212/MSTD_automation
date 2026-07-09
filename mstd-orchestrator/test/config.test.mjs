import { describe, it, expect } from "vitest";
import { loadServerConfig } from "../server/config.mjs";

describe("loadServerConfig", () => {
  it("aggregates env knobs with sane defaults", () => {
    const c = loadServerConfig({ MSTD_SESSION_SECRET: "s", PORT: "9000" });
    expect(c.port).toBe(9000);
    expect(c.sessionSecret).toBe("s");
    expect(c.sessionTtlSeconds).toBe(7 * 86400);
    expect(c.maxConcurrentPi).toBe(2);
    expect(c.enableWrite).toBe(false);
    expect(c.pi.provider).toBe("cz-gpt");
    expect(c.pi.model).toBe("gpt-5.5");
    expect(c.feishu).toHaveProperty("authorizeUrl");
  });
  it("honors overrides", () => {
    const c = loadServerConfig({ MSTD_SESSION_SECRET: "s", MSTD_MAX_CONCURRENT_PI: "3", MSTD_ENABLE_WRITE: "1", PI_MODEL: "gpt-5.5-mini" });
    expect(c.maxConcurrentPi).toBe(3);
    expect(c.enableWrite).toBe(true);
    expect(c.pi.model).toBe("gpt-5.5-mini");
  });
});

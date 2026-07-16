// pi-ext/time.ts 的纯函数 computeTimeInfo：给定时钟+时区，产人类串 + 带偏移 ISO。
import { describe, it, expect } from "vitest";
import { computeTimeInfo } from "../pi-ext/time.ts";

// 2026-07-16T06:32:00Z = 北京 14:32；纽约（EDT, UTC-4）02:32
const FIXED = () => new Date("2026-07-16T06:32:00Z");

describe("time tool computeTimeInfo", () => {
  it("缺省北京时间：ISO 带 +08:00", () => {
    const info = computeTimeInfo(FIXED);
    expect(info.timezone).toBe("Asia/Shanghai");
    expect(info.iso).toBe("2026-07-16T14:32:00+08:00");
    expect(info.human).toContain("14:32");
  });

  it("换算到指定时区：纽约 -04:00", () => {
    const info = computeTimeInfo(FIXED, "America/New_York");
    expect(info.iso).toBe("2026-07-16T02:32:00-04:00");
    expect(info.human).toContain("02:32");
  });

  it("无效时区抛错（由 execute 层 fail-closed 回退）", () => {
    expect(() => computeTimeInfo(FIXED, "Not/AZone")).toThrow();
  });
});

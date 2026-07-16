// server/time/now.mjs：逐回合注入用的时间助手。now 注入固定时钟以断言确定性。
import { describe, it, expect } from "vitest";
import { SHANGHAI_TZ, formatNow, nowIso } from "../server/time/now.mjs";

// 2026-07-16T06:32:00Z = 北京时间 14:32（周四）
const FIXED = () => new Date("2026-07-16T06:32:00Z");

describe("time/now", () => {
  it("SHANGHAI_TZ 是北京时区常量", () => {
    expect(SHANGHAI_TZ).toBe("Asia/Shanghai");
  });

  it("formatNow 产出含日期/星期/时分/北京时间标注的人类可读串", () => {
    const s = formatNow(FIXED);
    expect(s).toContain("2026年7月16日");
    expect(s).toContain("星期四");
    expect(s).toContain("14:32");
    expect(s).toContain("（北京时间）");
  });

  it("nowIso 产出带 +08:00 偏移的严格 ISO 8601", () => {
    expect(nowIso(FIXED)).toBe("2026-07-16T14:32:00+08:00");
  });

  it("默认 now 不抛错且形态正确", () => {
    expect(typeof formatNow()).toBe("string");
    expect(nowIso()).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\+08:00$/);
  });
});

import { describe, it, expect } from "vitest";
import { formatDueAtBeijing } from "../server/time/beijing-iso.mjs";

describe("formatDueAtBeijing", () => {
  it("renders epoch ms as Asia/Shanghai ISO with +08:00 offset", () => {
    const ms = Date.parse("2026-07-17T09:00:00+08:00");
    const s = formatDueAtBeijing(ms);
    expect(s).toBe("2026-07-17T09:00:00+08:00");
    expect(s).not.toContain("Z");
    expect(s).not.toBe(new Date(ms).toISOString());
  });
});

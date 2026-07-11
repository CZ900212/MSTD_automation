// Task 8 C1：persona hook——工厂创建时读 SOUL 恰一次,每回合复用同一 prompt 整体替换。
import { describe, it, expect, vi } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import registerPersona, { createPersonaHook } from "../pi-ext/persona.ts";
import { buildPersonaPrompt } from "../pi-ext/persona-prompt.ts";

const CODING_DEFAULT_SENTINEL = "You are a coding agent SENTINEL_XYZ";

describe("C1 persona hook", () => {
  it("SOUL 只读一次;两次触发逐字节同 prompt;整体替换不拼接默认词", async () => {
    const readFile = vi.fn(() => "# 身份\n你是「小达」…");
    const now = () => new Date(Date.UTC(2026, 6, 10, 4, 0, 0));   // 北京 2026-07-10 12:00
    const hook = createPersonaHook({ soulPath: "/fake/SOUL.md", readFile, now, workspace: "/tmp/agent-workspace" });
    expect(readFile).toHaveBeenCalledTimes(1);                    // 工厂期读一次
    expect(readFile).toHaveBeenCalledWith("/fake/SOUL.md", "utf8"); // §5.2:锁路径+编码,防读错文件

    const r1 = await hook({ systemPrompt: CODING_DEFAULT_SENTINEL });
    const r2 = await hook({ systemPrompt: CODING_DEFAULT_SENTINEL });
    expect(readFile).toHaveBeenCalledTimes(1);                    // 回合触发不再读
    expect(r1.systemPrompt).toBe(r2.systemPrompt);                // 逐字节稳定
    const expected = buildPersonaPrompt({
      soul: "# 身份\n你是「小达」…", dateStr: "2026年7月10日", workspace: "/tmp/agent-workspace",
    });
    expect(r1).toEqual({ systemPrompt: expected });               // 精确等于纯函数产物
    expect(r1.systemPrompt).not.toContain("SENTINEL_XYZ");        // 整体替换,默认词零残留
    expect(r1.systemPrompt).not.toMatch(/coding agent/);
  });

  it("soulPath 缺失 fail-fast", () => {
    expect(() => createPersonaHook({ soulPath: "" })).toThrow(/MSTD_SOUL_PATH/);
  });

  // §5.2 审卷采纳:时区杀——UTC 与上海跨日的时刻必须按北京时间取日期,改 UTC 即红
  it("dateStr 按 Asia/Shanghai 取日:UTC 晚间 = 北京次日", async () => {
    const now = () => new Date(Date.UTC(2026, 6, 10, 18, 30, 0)); // UTC 07-10 18:30 = 北京 07-11 02:30
    const hook = createPersonaHook({ soulPath: "/f", readFile: () => "魂", now, workspace: "/w" });
    const { systemPrompt } = await hook({});
    expect(systemPrompt).toContain("2026年7月11日");
    expect(systemPrompt).not.toContain("2026年7月10日");
  });

  // §5.2 审卷采纳:default export 的生产注册路径此前零覆盖——no-op/错事件名/错 hook 均可逃逸
  it("default export:恰一次注册 before_agent_start,捕获的 hook 产出含 SOUL 的整体替换词", async () => {
    const dir = mkdtempSync(join(tmpdir(), "mstd-soul-"));
    const soulPath = join(dir, "SOUL.md");
    writeFileSync(soulPath, "# 身份\nSOUL_REG_SENTINEL_42");
    const prev = process.env.MSTD_SOUL_PATH;
    process.env.MSTD_SOUL_PATH = soulPath;
    try {
      const on = vi.fn();
      registerPersona({ on });
      expect(on).toHaveBeenCalledTimes(1);
      expect(on.mock.calls[0][0]).toBe("before_agent_start");
      const hook = on.mock.calls[0][1];
      const r = await hook({ systemPrompt: CODING_DEFAULT_SENTINEL });
      expect(r.systemPrompt).toContain("SOUL_REG_SENTINEL_42");
      expect(r.systemPrompt).not.toContain("SENTINEL_XYZ");
    } finally {
      if (prev === undefined) delete process.env.MSTD_SOUL_PATH; else process.env.MSTD_SOUL_PATH = prev;
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

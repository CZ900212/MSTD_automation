import { describe, it, expect, vi } from "vitest";
import { startLarkHealth, makeDmAlert } from "../server/health/lark-profile.mjs";

describe("lark health", () => {
  it("auth status 失败 → last.ok=false，且仅在边沿告警一次", async () => {
    const alert = vi.fn(async () => {});
    let healthy = true;
    const runLark = async () =>
      healthy
        ? { exitCode: 0, stdout: "logged in", stderr: "" }
        : { exitCode: 1, stdout: "", stderr: "token expired" };
    const h = startLarkHealth({
      runLark,
      alert,
      log: () => {},
      setIntervalFn: () => ({ unref() {} }),
    });
    await h.checkOnce();
    expect(h.last.ok).toBe(true);
    healthy = false;
    await h.checkOnce();
    await h.checkOnce(); // 连续失败第二次
    expect(h.last.ok).toBe(false);
    expect(alert).toHaveBeenCalledTimes(1);
    h.stop();
  });

  it("故障后恢复:打印已恢复且不再触发告警;alert 通道抛错不炸 checkOnce", async () => {
    const alert = vi.fn(async () => { throw new Error("DM 通道抖动"); });
    const logs = [];
    let healthy = false;
    const h = startLarkHealth({
      runLark: async () => (healthy
        ? { exitCode: 0, stdout: "logged in", stderr: "" }
        : { exitCode: 1, stdout: "", stderr: "token expired" }),
      alert,
      log: (line) => logs.push(String(line)),
      setIntervalFn: () => ({ unref() {} }),
    });
    await expect(h.checkOnce()).resolves.toMatchObject({ ok: false }); // alert 抛错被吞,不 reject
    expect(alert).toHaveBeenCalledTimes(1);
    healthy = true;
    await h.checkOnce();                                              // fail→ok 恢复边沿
    expect(h.last.ok).toBe(true);
    expect(logs.some((l) => l.includes("已恢复"))).toBe(true);
    expect(alert).toHaveBeenCalledTimes(1);                           // 恢复不再告警
    h.stop();
  });

  it("makeDmAlert:openId 缺失返回 null;argv 结构与 JSON content 正确", async () => {
    expect(makeDmAlert({ runLark: async () => {}, openId: "" })).toBeNull();
    const calls = [];
    const alert = makeDmAlert({ runLark: async (argv) => calls.push(argv), openId: "ou_admin" });
    await alert("token expired");
    const argv = calls[0];
    expect(argv.slice(0, 2)).toEqual(["im", "+messages-send"]);
    expect(argv).toContain("--as");
    expect(argv[argv.indexOf("--user-id") + 1]).toBe("ou_admin");
    const content = JSON.parse(argv[argv.indexOf("--content") + 1]);
    expect(content.text).toContain("健康检查失败");
    expect(content.text).toContain("token expired");
  });

  it("turns a runner exception into an unready result rather than rejecting readiness", async () => {
    const h = startLarkHealth({
      runLark: async () => { throw new Error("lark executable unavailable"); },
      log: () => {},
      setIntervalFn: () => ({ unref() {} }),
    });
    await expect(h.checkOnce()).resolves.toMatchObject({ ok: false, ready: false });
    expect(h.last.detail).toMatch(/unavailable/);
    h.stop();
  });
});

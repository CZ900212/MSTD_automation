import { describe, it, expect, vi } from "vitest";
import { startLarkHealth } from "../server/health/lark-profile.mjs";

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

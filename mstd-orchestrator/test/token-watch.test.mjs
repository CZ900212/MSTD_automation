import { describe, it, expect } from "vitest";
import { createTokenWatch } from "../server/ticker/token-watch.mjs";

const statusJson = (refreshExpiresAt) => JSON.stringify({
  identities: { user: { tokenStatus: "valid", refreshExpiresAt } },
});

function fixedNow(iso) {
  const t = new Date(iso).getTime();
  return () => t;
}

describe("token-watch：refresh token 到期哨兵", () => {
  it("剩余 > 48h 不告警", async () => {
    const alerts = [];
    const w = createTokenWatch({
      runLark: async () => ({ exitCode: 0, stdout: statusJson("2026-07-19T06:21:42+08:00"), stderr: "" }),
      alert: async (m) => alerts.push(m),
      now: fixedNow("2026-07-12T06:00:00+08:00"),
    });
    const r = await w.checkOnce();
    expect(r).toMatchObject({ ok: true, warned: false });
    expect(alerts.length).toBe(0);
  });

  it("剩余 < 48h 告警一次，同一天不重复，跨天再警", async () => {
    const alerts = [];
    let nowTs = new Date("2026-07-18T06:00:00+08:00").getTime();
    const w = createTokenWatch({
      runLark: async () => ({ exitCode: 0, stdout: statusJson("2026-07-19T06:21:42+08:00"), stderr: "" }),
      alert: async (m) => alerts.push(m),
      now: () => nowTs,
    });
    expect((await w.checkOnce()).warned).toBe(true);
    expect((await w.checkOnce()).warned).toBe(false);   // 同天去重
    expect(alerts.length).toBe(1);
    expect(alerts[0]).toContain("2026-07-19");
    nowTs += 86_400_000;                                 // 次日
    expect((await w.checkOnce()).warned).toBe(true);
    expect(alerts.length).toBe(2);
  });

  it("auth status 失败/坏 JSON/缺 refreshExpiresAt → ok:false 不炸", async () => {
    const mk = (stdout, exitCode = 0) => createTokenWatch({
      runLark: async () => ({ exitCode, stdout, stderr: "" }),
      log: () => {},
    });
    expect((await mk("", 1).checkOnce()).ok).toBe(false);
    expect((await mk("not json").checkOnce()).ok).toBe(false);
    expect((await mk(JSON.stringify({ identities: {} })).checkOnce()).ok).toBe(false);
  });

  it("告警通道抛错不炸哨兵", async () => {
    const w = createTokenWatch({
      runLark: async () => ({ exitCode: 0, stdout: statusJson("2026-07-12T12:00:00+08:00"), stderr: "" }),
      alert: async () => { throw new Error("信道挂了"); },
      now: fixedNow("2026-07-12T06:00:00+08:00"),
      log: () => {},
    });
    expect((await w.checkOnce()).warned).toBe(true);
  });
});

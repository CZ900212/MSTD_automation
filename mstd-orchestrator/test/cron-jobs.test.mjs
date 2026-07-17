import { describe, it, expect, beforeEach } from "vitest";
import { openDb, migrate } from "../server/db/index.mjs";
import { parseSchedule, nextRunAt, createCronStore } from "../server/ticker/cron-jobs.mjs";

const T0 = Date.UTC(2026, 6, 9, 10, 0, 0); // 2026-07-09 10:00 UTC = 18:00 北京

describe("schedule 解析", () => {
  it("四种语法：间隔 / every 前缀 / cron 表达式 / 一次性 ISO", () => {
    expect(parseSchedule("30m")).toEqual({ type: "interval", ms: 30 * 60_000 });
    expect(parseSchedule("every 2h")).toEqual({ type: "interval", ms: 2 * 3600_000 });
    expect(parseSchedule("0 9 * * *").type).toBe("cron");
    expect(parseSchedule("2026-08-01T09:00:00Z")).toEqual({ type: "once", at: Date.parse("2026-08-01T09:00:00Z") });
    expect(() => parseSchedule("乱写")).toThrow();
  });

  it("interval：未跑过立即到期；跑过按间隔推", () => {
    expect(nextRunAt("30m", { lastRunAt: null, now: T0 })).toBeLessThanOrEqual(T0);
    expect(nextRunAt("30m", { lastRunAt: T0, now: T0 })).toBe(T0 + 30 * 60_000);
  });

  it("cron 跨天：北京 18:05（UTC 10:05）后要求 UTC 09:00 → 次日", () => {
    const next = nextRunAt("0 9 * * *", { lastRunAt: null, now: T0 + 5 * 60_000 });
    const d = new Date(next);
    expect(d.getUTCHours()).toBe(9);
    expect(d.getUTCMinutes()).toBe(0);
    expect(d.getUTCDate()).toBe(10);      // 次日
  });

  it("一次性：到点前 = 该时刻；已过 = 该时刻（due 判定由 picker 做）", () => {
    const at = Date.parse("2026-08-01T09:00:00Z");
    expect(nextRunAt("2026-08-01T09:00:00Z", { lastRunAt: null, now: T0 })).toBe(at);
    expect(nextRunAt("2026-08-01T09:00:00Z", { lastRunAt: at, now: at + 1000 })).toBeNull();  // 跑过即不再来
  });
});

describe("cron store + duePicker", () => {
  let db, store;
  beforeEach(() => {
    db = openDb();
    migrate(db);
    store = createCronStore(db, { now: () => T0 - 3600_000 });   // 建于 T0 前 1 小时
  });

  it("到期挑选 + 防重复触发 + 一次性任务跑完自动 disabled", () => {
    store.add({ id: "daily", schedule: "0 9 * * *", prompt: "发日报", deliverTo: "feishu:group:oc_1", ownerOpenId: "ou_a" });
    store.add({ id: "half", schedule: "30m", prompt: "巡检", deliverTo: "cron:half" });
    store.add({ id: "once", schedule: new Date(T0 - 1000).toISOString(), prompt: "一次性提醒", deliverTo: "feishu:p2p:ou_a" });

    const due = store.duePicker(T0);
    const ids = due.map((j) => j.id);
    expect(ids).toContain("half");        // 没跑过立即到期
    expect(ids).toContain("once");        // 已过时刻
    expect(ids).not.toContain("daily");   // UTC 10:00 > 09:00，今天已过且没跑过 → 下一次是明天 09:00

    // 挑选即标记 last_run_at → 同一时刻再挑不重复
    expect(store.duePicker(T0).map((j) => j.id)).toEqual([]);

    // 一次性任务跑完 disabled
    store.markDone("once", T0);
    expect(db.prepare("SELECT enabled FROM cron_jobs WHERE id='once'").get().enabled).toBe(0);
    expect(db.prepare("SELECT enabled FROM cron_jobs WHERE id='half'").get().enabled).toBe(1);
  });
});

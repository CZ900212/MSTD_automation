import { describe, it, expect } from "vitest";
import { openDb, migrate } from "../server/db/index.mjs";
import { createBudget } from "../server/models/budget.mjs";

const DAY = 86_400_000;

describe("token budget", () => {
  it("会话/当日两个维度分别封顶；跨天清零；超限触发告警回调", () => {
    const db = openDb();
    migrate(db);
    const alerts = [];
    const budget = createBudget(db, { dailyLimit: 100, sessionLimit: 50, onExceed: (x) => alerts.push(x) });

    const t0 = 10 * DAY + 1000;
    expect(budget.allow("s1", t0)).toEqual({ ok: true });
    budget.record("s1", { prompt_tokens: 30, completion_tokens: 10 }, t0);
    expect(budget.allow("s1", t0)).toEqual({ ok: true });          // 40 < 50
    budget.record("s1", { prompt_tokens: 10, completion_tokens: 5 }, t0);
    expect(budget.allow("s1", t0)).toEqual({ ok: false, scope: "session" });  // 55 >= 50
    expect(alerts.at(-1)).toMatchObject({ scope: "session", sessionKey: "s1" });

    // 其他会话不受 s1 会话维度影响，但共享当日维度
    expect(budget.allow("s2", t0)).toEqual({ ok: true });          // daily 55 < 100
    budget.record("s2", { prompt_tokens: 50, completion_tokens: 0 }, t0);
    expect(budget.allow("s3", t0)).toEqual({ ok: false, scope: "daily" });    // 105 >= 100

    // 跨天清零
    const t1 = 11 * DAY + 1000;
    expect(budget.allow("s1", t1)).toEqual({ ok: true });
    expect(budget.allow("s3", t1)).toEqual({ ok: true });
  });
});

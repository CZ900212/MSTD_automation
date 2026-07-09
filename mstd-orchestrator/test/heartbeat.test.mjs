import { describe, it, expect, vi, beforeEach } from "vitest";
import { mkdtempSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { openDb, migrate } from "../server/db/index.mjs";
import { createSessionStore } from "../server/sessions/store.mjs";
import { createHeartbeat } from "../server/ticker/heartbeat.mjs";

const BJ_10AM = Date.UTC(2026, 6, 9, 2, 0, 0);   // 北京 10:00
const BJ_11PM = Date.UTC(2026, 6, 9, 15, 0, 0);  // 北京 23:00

describe("HEARTBEAT（清单 + 心跳回合）", () => {
  let root, caller, brain, hb;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "mstd-hb-"));
    const db = openDb();
    migrate(db);
    caller = { call: vi.fn(async () => ({ text: "HEARTBEAT_OK", usage: null })) };
    brain = { turn: vi.fn(async () => ({ finalText: "", events: [] })), isBusy: () => false };
    hb = createHeartbeat({ rootDir: root, caller, brain, agentStore: createSessionStore(db) });
  });

  it("工具加项：行格式 `- [ ] <ISO> <事项> -> <目标>`", () => {
    hb.addItem({ dueIso: "2026-07-09T03:00:00Z", text: "提醒喝水", deliverTo: "feishu:p2p:ou_a" });
    const content = readFileSync(join(root, "HEARTBEAT.md"), "utf8");
    expect(content).toContain("- [ ] 2026-07-09T03:00:00Z 提醒喝水 -> feishu:p2p:ou_a");
  });

  it("activeHours 外不跑（不调模型）", async () => {
    hb.addItem({ dueIso: "2026-07-09T03:00:00Z", text: "x", deliverTo: "feishu:p2p:ou_a" });
    const r = await hb.tick(BJ_11PM);
    expect(r.skipped).toBe("inactive_hours");
    expect(caller.call).not.toHaveBeenCalled();
  });

  it("清单为空不调模型；HEARTBEAT_OK 被吞（不触发 brain）", async () => {
    const r0 = await hb.tick(BJ_10AM);
    expect(r0.skipped).toBe("empty");
    expect(caller.call).not.toHaveBeenCalled();

    hb.addItem({ dueIso: "2026-07-10T03:00:00Z", text: "明天的事", deliverTo: "feishu:p2p:ou_a" });
    const r1 = await hb.tick(BJ_10AM);
    expect(r1.ok).toBe(true);
    expect(brain.turn).not.toHaveBeenCalled();
  });

  it("到期项触发 brain 执行并勾选完成", async () => {
    hb.addItem({ dueIso: "2026-07-09T01:00:00Z", text: "该提醒了", deliverTo: "feishu:p2p:ou_a" });
    caller.call.mockResolvedValue({ text: '{"due":[0]}', usage: null });
    await hb.tick(BJ_10AM);
    expect(brain.turn).toHaveBeenCalledTimes(1);
    const arg = brain.turn.mock.calls[0][0];
    expect(arg.brief).toContain("该提醒了");
    expect(arg.brief).toContain("feishu:p2p:ou_a");
    const content = readFileSync(join(root, "HEARTBEAT.md"), "utf8");
    expect(content).toContain("- [x]");
    expect(content).not.toContain("- [ ] 2026-07-09T01:00:00Z");
  });
});

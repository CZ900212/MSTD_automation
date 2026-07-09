import { describe, it, expect, vi, beforeEach } from "vitest";
import { openDb, migrate } from "../server/db/index.mjs";
import { createSessionStore } from "../server/sessions/store.mjs";
import { createActorPool } from "../server/sessions/actor.mjs";
import { createReinjector } from "../server/jobs/reinjector.mjs";

describe("后台 job 回注（版本判定 + 进度心跳）", () => {
  let db, store, brain, outbound, reinject;
  beforeEach(() => {
    db = openDb();
    migrate(db);
    store = createSessionStore(db);
    brain = { turn: vi.fn(async () => ({ finalText: "", events: [] })), isBusy: () => false };
    outbound = { editMessage: vi.fn(async () => ({})), sendMessage: vi.fn(async () => ({ messageId: "om_x" })) };
    reinject = createReinjector({ store, actors: createActorPool(), brain, outbound, versionThreshold: 3 });
  });

  it("新鲜回注：版本差 ≤3 → 正常播报 prompt", async () => {
    const s = store.getOrCreate("feishu:p2p:ou_a", { kind: "p2p" });
    store.bumpVersion(s.id); store.bumpVersion(s.id);               // 现 version=2，发起时 0
    await reinject.onJobComplete({ jobId: "j1", sessionKey: "feishu:p2p:ou_a", sessionVersion: 0, ok: true, result: "检索完成：找到 3 家供应商" });
    expect(brain.turn).toHaveBeenCalled();
    const arg = brain.turn.mock.calls[0][0];
    expect(arg.brief).toContain("播报");
    expect(arg.brief).not.toContain("翻篇");
    expect(arg.context).toContain("3 家供应商");
  });

  it("过时回注：版本差 >3 → prompt 标注话题可能翻篇", async () => {
    const s = store.getOrCreate("feishu:p2p:ou_b", { kind: "p2p" });
    for (let i = 0; i < 5; i++) store.bumpVersion(s.id);
    await reinject.onJobComplete({ jobId: "j2", sessionKey: "feishu:p2p:ou_b", sessionVersion: 0, ok: true, result: "旧结果" });
    expect(brain.turn.mock.calls[0][0].brief).toContain("翻篇");
  });

  it("失败 job 回注：brief 说明失败", async () => {
    store.getOrCreate("feishu:p2p:ou_c", { kind: "p2p" });
    await reinject.onJobComplete({ jobId: "j3", sessionKey: "feishu:p2p:ou_c", sessionVersion: 0, ok: false, error: "超时" });
    expect(brain.turn.mock.calls[0][0].brief).toContain("失败");
  });

  it("进度心跳：每 3 分钟编辑同一条消息，不发新消息；stop 后停止", () => {
    vi.useFakeTimers();
    reinject = createReinjector({ store, actors: createActorPool(), brain, outbound });  // fake timer 生效后构造
    reinject.trackProgress({ jobId: "j4", messageId: "om_prog" });
    vi.advanceTimersByTime(3 * 60_000);
    vi.advanceTimersByTime(3 * 60_000);
    expect(outbound.editMessage).toHaveBeenCalledTimes(2);
    expect(outbound.editMessage.mock.calls[0][0].messageId).toBe("om_prog");
    expect(outbound.sendMessage).not.toHaveBeenCalled();
    reinject.stopProgress("j4");
    vi.advanceTimersByTime(10 * 60_000);
    expect(outbound.editMessage).toHaveBeenCalledTimes(2);
    vi.useRealTimers();
  });
});

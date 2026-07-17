import { describe, it, expect, vi, beforeEach } from "vitest";
import { openDb, migrate } from "../server/db/index.mjs";
import { createSessionStore } from "../server/sessions/store.mjs";
import { createReinjector } from "../server/jobs/reinjector.mjs";
import { createContextBudget } from "../server/safety/context-budget.mjs";

describe("后台 job 回注（版本判定）", () => {
  let db, store, actors, brain, reinject;
  beforeEach(() => {
    db = openDb();
    migrate(db);
    store = createSessionStore(db);
    actors = { enqueue: vi.fn((_, callback) => callback()) };
    brain = { turn: vi.fn(async () => ({ finalText: "", events: [] })), isBusy: () => false };
    reinject = createReinjector({ store, actors, brain, versionThreshold: 3 });
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
    expect(actors.enqueue).toHaveBeenCalledWith("feishu:p2p:ou_a", expect.any(Function));
  });

  it("public 结果维持正常播报，internal 结果只允许播报结论与影响", async () => {
    store.getOrCreate("feishu:p2p:ou_public", { kind: "p2p" });
    await reinject.onJobComplete({
      jobId: "j-public", sessionKey: "feishu:p2p:ou_public", sessionVersion: 0, ok: true,
      derived_result: { text: "公开结果", sensitivity: "public" },
    });
    expect(brain.turn.mock.calls[0][0].brief).toContain("请向用户播报结果要点");

    store.getOrCreate("feishu:p2p:ou_internal", { kind: "p2p" });
    await reinject.onJobComplete({
      jobId: "j-internal", sessionKey: "feishu:p2p:ou_internal", sessionVersion: 0, ok: true,
      derived_result: { text: "内部诊断", sensitivity: "internal" },
    });
    const internalBrief = brain.turn.mock.calls[1][0].brief;
    expect(internalBrief).toContain("结果供你内部参考");
    expect(internalBrief).toContain("只说结论与影响，不引用原文细节");
    expect(internalBrief).not.toContain("请向用户播报结果要点");
  });

  it("过时回注：版本差 >3 → prompt 标注话题可能翻篇", async () => {
    const s = store.getOrCreate("feishu:p2p:ou_b", { kind: "p2p" });
    for (let i = 0; i < 5; i++) store.bumpVersion(s.id);
    await reinject.onJobComplete({ jobId: "j2", sessionKey: "feishu:p2p:ou_b", sessionVersion: 0, ok: true, result: "旧结果" });
    expect(brain.turn.mock.calls[0][0].brief).toContain("翻篇");
  });

  it("高敏 derived_result 受控终止，不进入 resident brain", async () => {
    store.getOrCreate("feishu:p2p:ou_c", { kind: "p2p" });
    await reinject.onJobComplete({
      jobId: "j3", sessionKey: "feishu:p2p:ou_c", sessionVersion: 0, ok: true,
      derived_result: { text: "身份证号 110101199001011234", sensitivity: "sensitive", parent: { sessionKey: "feishu:p2p:ou_c" } },
    });
    expect(brain.turn).not.toHaveBeenCalled();
  });

  it("signed envelope binds authoritative background parent provenance and configured budget", async () => {
    const signer = (payload) => `a${Buffer.from(payload).toString("hex").slice(0, 63)}`.padEnd(64, "0").slice(0, 64);
    const contextBudget = createContextBudget({ maxBytes: 8, marker: "" });
    reinject = createReinjector({ store, actors, brain, contextSigner: signer, contextBudget });
    store.getOrCreate("feishu:p2p:ou_parent", { kind: "p2p" });
    await reinject.onJobComplete({
      jobId: "j-parent", sessionKey: "feishu:p2p:ou_parent", sessionVersion: 2, ok: true,
      derived_result: {
        text: "1234567890", sensitivity: "internal",
        parent: { sessionKey: "feishu:p2p:forged", sessionVersion: 99, jobId: "forged", kind: "research", brief: "查报价" },
      },
    });
    const arg = brain.turn.mock.calls[0][0];
    expect(arg.contextEnvelope.content).toBe("12345678");
    expect(arg.contextEnvelope.byteLength).toBe(8);
    expect(arg.contextEnvelope.parentHashes).toHaveLength(1);
    expect(arg.contextEnvelope.signature).toMatch(/^[a-f0-9]{64}$/);
    // derived_result 不再透传 brain（runTurn 从不读取）；权威溯源只经签名 envelope 携带
    expect(arg.derived_result).toBeUndefined();
  });

  it("same provenance is deduplicated with exponential backoff", async () => {
    store.getOrCreate("feishu:p2p:ou_d", { kind: "p2p" });
    const event = { jobId: "j4", sessionKey: "feishu:p2p:ou_d", sessionVersion: 0, ok: true, derived_result: { text: "结果", sensitivity: "internal", parent: { sessionKey: "feishu:p2p:ou_d", kind: "research" } } };
    await reinject.onJobComplete(event);
    await reinject.onJobComplete(event);
    expect(brain.turn).toHaveBeenCalledTimes(1);
  });

  it("unknown sensitivity is fail-closed and source provenance cannot override completion identity", async () => {
    store.getOrCreate("feishu:p2p:ou_identity", { kind: "p2p" });
    const controlled = await reinject.onJobComplete({
      jobId: "j-identity", sessionKey: "feishu:p2p:ou_identity", sessionVersion: 2, ok: true,
      derived_result: { text: "机密", sensitivity: "future_classification", parent: { sessionKey: "feishu:p2p:ou_other", jobId: "forged" } },
    });
    expect(controlled.status).toBe("controlled");
    expect(brain.turn).not.toHaveBeenCalled();
  });

  it("失败 job 回注：brief 只含分类，不含 error 原文", async () => {
    store.getOrCreate("feishu:p2p:ou_e", { kind: "p2p" });
    await reinject.onJobComplete({
      jobId: "j5", sessionKey: "feishu:p2p:ou_e", sessionVersion: 0, ok: false,
      errorKind: "timeout", error: "read_file 在 /srv/secret/workdir 没跑通",
    });
    const brief = brain.turn.mock.calls[0][0].brief;
    expect(brief).toContain("执行失败（分类：timeout）");
    expect(brief).toContain("不要描述技术细节");
    expect(brief).not.toContain("read_file");
    expect(brief).not.toContain("/srv/secret/workdir");
  });

  it("origin 会话 actor callback 释放前不进入 brain.turn", async () => {
    store.getOrCreate("feishu:p2p:ou_hold", { kind: "p2p" });
    let release;
    actors.enqueue.mockImplementation((_, callback) => new Promise((resolve, reject) => {
      release = () => Promise.resolve(callback()).then(resolve, reject);
    }));

    const pending = reinject.onJobComplete({
      jobId: "j-hold",
      sessionKey: "feishu:p2p:ou_hold",
      sessionVersion: 0,
      ok: true,
      result: "稍后回注",
    });
    expect(actors.enqueue).toHaveBeenCalledWith("feishu:p2p:ou_hold", expect.any(Function));
    expect(brain.turn).not.toHaveBeenCalled();

    await release();
    await pending;
    expect(brain.turn).toHaveBeenCalledTimes(1);
  });

  it("prep 段抛错收敛为 controlled/prep_failed,不产生 unhandled rejection", async () => {
    const hostileStore = { getOrCreate: () => { throw new Error("db 抖动"); } };
    // 贴近真实 actor 语义:回调抛错成为返回 promise 的拒绝(而非同步 throw)
    const asyncActors = { enqueue: (_, cb) => Promise.resolve().then(cb) };
    const r = createReinjector({ store: hostileStore, actors: asyncActors, brain, log: () => {} });
    await expect(r.onJobComplete({
      jobId: "jx", sessionKey: "feishu:p2p:ou_a", sessionVersion: 0, ok: true, result: "文本",
    })).resolves.toMatchObject({ status: "controlled", reason: "prep_failed" });
    expect(brain.turn).not.toHaveBeenCalled();
  });
});

import { describe, expect, it } from "vitest";
import { createVerbatimGuard } from "../server/safety/verbatim-guard.mjs";
import { checkReplyPostRender } from "../server/safety/reply-egress.mjs";

const SOURCE = "第三季度武汉项目预算总额为四百二十万元，其中人力成本占百分之六十，剩余部分分配给设备采购与外包服务，需在十月底之前完成全部审批流程。";

describe("逐字引用守卫（群禁止/私聊预算）", () => {
  it("群聊逐字复制已读源被拒；改写/摘要不拦", () => {
    const guard = createVerbatimGuard();
    guard.record("s", SOURCE);
    const verbatim = guard.check("s", `原文说：“${SOURCE.slice(0, 60)}”`, { audience: "group" });
    expect(verbatim).toMatchObject({ ok: false, code: "post_render_group_verbatim" });
    const paraphrase = guard.check("s", "三季度预算约四百多万，人力占大头，十月底前要走完审批。", { audience: "group" });
    expect(paraphrase).toMatchObject({ ok: true, verbatimChars: 0 });
  });

  it("私聊逐字引用受总量预算：短引用放行，超预算拒绝", () => {
    const guard = createVerbatimGuard({ p2pBudgetChars: 100 });
    const longSource = SOURCE.repeat(4);
    guard.record("s", longSource);
    const short = guard.check("s", `关键一句：“${SOURCE.slice(0, 40)}”`, { audience: "p2p" });
    expect(short.ok).toBe(true);
    const flood = guard.check("s", longSource.slice(0, 300), { audience: "p2p" });
    expect(flood).toMatchObject({ ok: false, code: "post_render_verbatim_budget" });
  });

  it("未登记过源的会话不受影响；clear 后恢复放行", () => {
    const guard = createVerbatimGuard();
    expect(guard.check("fresh", SOURCE, { audience: "group" }).ok).toBe(true);
    guard.record("s", SOURCE);
    expect(guard.check("s", SOURCE, { audience: "group" }).ok).toBe(false);
    guard.clear("s");
    expect(guard.check("s", SOURCE, { audience: "group" }).ok).toBe(true);
  });

  it("空白/大小写/全半角归一化后仍能命中", () => {
    const guard = createVerbatimGuard();
    guard.record("s", "Quarterly budget for the Wuhan project is 4.2 million CNY total");
    const spaced = guard.check("s", "quarterly  budget for the wuhan project is 4.2 million cny total", { audience: "group" });
    expect(spaced.ok).toBe(false);
  });

  it("接入 checkReplyPostRender：群命中逐字即整体拒绝", () => {
    const guard = createVerbatimGuard();
    guard.record("feishu:group:oc_a", SOURCE);
    const post = checkReplyPostRender({
      provenance: { epoch: 1, provenanceHash: "p" },
      deliverKey: "feishu:group:oc_a",
      sessionKey: "feishu:group:oc_a",
      text: `逐字转发：${SOURCE.slice(0, 60)}`,
      verbatimGuard: guard,
    });
    expect(post).toMatchObject({ ok: false, code: "post_render_group_verbatim" });
  });
});

import { describe, it, expect } from "vitest";
import { createDeliverGrants } from "../server/sessions/deliver-grants.mjs";

describe("deliver-grants（reply.target 投递授权）", () => {
  it("默认仅 target === source 放行", () => {
    const g = createDeliverGrants();
    expect(g.allowed("feishu:p2p:ou_a", "feishu:p2p:ou_a")).toBe(true);
    expect(g.allowed("feishu:p2p:ou_a", "feishu:p2p:ou_b")).toBe(false);
    expect(g.allowed("cron:job-1", "feishu:group:oc_1")).toBe(false);
  });

  it("grant 只放指定 source→target 对,不外溢", () => {
    const g = createDeliverGrants();
    g.grant("cron:job-1", "feishu:group:oc_1");
    expect(g.allowed("cron:job-1", "feishu:group:oc_1")).toBe(true);
    // 别的 source 不能借用
    expect(g.allowed("cron:job-2", "feishu:group:oc_1")).toBe(false);
    // 同 source 的其他 target 不放行
    expect(g.allowed("cron:job-1", "feishu:group:oc_2")).toBe(false);
    // 自会话恒放行
    expect(g.allowed("cron:job-2", "cron:job-2")).toBe(true);
  });

  it("同 source 可持多个 grant;revoke 一次性收回该 source 全部 grant", () => {
    const g = createDeliverGrants();
    g.grant("cron:j", "feishu:p2p:ou_a");
    g.grant("cron:j", "feishu:group:oc_b");
    expect(g.allowed("cron:j", "feishu:p2p:ou_a")).toBe(true);
    expect(g.allowed("cron:j", "feishu:group:oc_b")).toBe(true);
    g.revoke("cron:j");
    expect(g.allowed("cron:j", "feishu:p2p:ou_a")).toBe(false);
    expect(g.allowed("cron:j", "feishu:group:oc_b")).toBe(false);
    // revoke 不影响自会话默认放行
    expect(g.allowed("cron:j", "cron:j")).toBe(true);
  });

  it("revoke 不存在的 source 不抛错;grant 后其他 source 的 revoke 不误伤", () => {
    const g = createDeliverGrants();
    expect(() => g.revoke("never-granted")).not.toThrow();
    g.grant("a", "t");
    g.revoke("b");
    expect(g.allowed("a", "t")).toBe(true);
  });
});

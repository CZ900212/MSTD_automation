import { describe, it, expect } from "vitest";
import { createSessionTokenRegistry } from "../server/http/session-tokens.mjs";

describe("C0.3 会话绑定 token 注册表", () => {
  it("issue/resolve/revoke 闭环;token 不可预测且互不相同", () => {
    const reg = createSessionTokenRegistry();
    const t1 = reg.issue("feishu:p2p:ou_a");
    const t2 = reg.issue("feishu:group:oc_b");
    expect(t1).not.toBe(t2);
    expect(typeof t1).toBe("string");
    expect(t1.length).toBeGreaterThanOrEqual(16);
    expect(reg.resolve(t1)).toBe("feishu:p2p:ou_a");
    expect(reg.resolve("不存在")).toBeNull();
    reg.revoke(t1);
    expect(reg.resolve(t1)).toBeNull();
    expect(reg.resolve(t2)).toBe("feishu:group:oc_b");
  });

  it("同一会话可同时持有多个 token(降级新旧 Pi 交接期);revoke 只吊销指定 token", () => {
    const reg = createSessionTokenRegistry();
    const t1 = reg.issue("k1");
    const t2 = reg.issue("k1");
    expect(t1).not.toBe(t2);
    reg.revoke(t1);
    expect(reg.resolve(t1)).toBeNull();
    expect(reg.resolve(t2)).toBe("k1");
  });

  it("revoke 容忍 null/undefined/未知 token,不抛错", () => {
    const reg = createSessionTokenRegistry();
    expect(() => reg.revoke(null)).not.toThrow();
    expect(() => reg.revoke(undefined)).not.toThrow();
    expect(() => reg.revoke("从未签发")).not.toThrow();
  });
});

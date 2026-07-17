// context envelope 元数据信任边界的 fail-closed 负例——此前只有合法枚举被间接覆盖。
import { describe, it, expect } from "vitest";
import { assertTrustBoundary, TRUST } from "../server/safety/trust-boundary.mjs";

describe("assertTrustBoundary fail-closed", () => {
  const valid = { trust: TRUST.UNTRUSTED, source: "user", scope: "feishu:p2p:ou_x", sensitivity: "internal" };

  it("合法组合放行并冻结", () => {
    const out = assertTrustBoundary(valid);
    expect(out).toEqual(valid);
    expect(Object.isFrozen(out)).toBe(true);
  });

  it.each([
    [{ ...valid, trust: "root" }, /trust/],
    [{ ...valid, trust: undefined }, /trust/],
    [{ ...valid, source: "model" }, /source/],
    [{ ...valid, sensitivity: "secret" }, /sensitivity/],
    [{ ...valid, scope: "" }, /scope/],
    [{ ...valid, scope: undefined }, /scope/],
    [{}, /trust/],
  ])("非法元数据 %j 直接抛错", (input, msg) => {
    expect(() => assertTrustBoundary(input)).toThrow(msg);
  });
});

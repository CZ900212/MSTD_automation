import { describe, it, expect } from "vitest";
import {
  familyForModelId,
  pickVariantBlock,
  withFamilyBlockPrefix,
  styleEnabled,
} from "../server/models/prompt-variants.mjs";

describe("familyForModelId", () => {
  it.each([
    ["gpt-5.6-sol", "gpt"],
    ["gpt-5.5", "gpt"],
    ["o1-preview", "gpt"],
    ["o3-mini", "gpt"],
    ["deepseek-v4-pro", "deepseek"],
    ["deepseek-v4-flash", "deepseek"],
    ["v4-pro", "deepseek"],
    ["GPT-5.6-SOL", "gpt"], // 大小写不敏感——避开 opencode 选择器只做一半大小写的漏匹配
    ["DeepSeek-V4-Pro", "deepseek"],
    ["claude-opus-4-8", "default"], // 未知 → 显式 default 兜底(绝不无块/崩溃)
    ["", "default"],
    [null, "default"],
    [undefined, "default"],
  ])("%s → %s", (id, fam) => {
    expect(familyForModelId(id)).toBe(fam);
  });
});

describe("styleEnabled 调用时读 env(非模块加载快照)", () => {
  it("默认关;与其他 MSTD_ENABLE_* 口径一致,只认 '1'", () => {
    expect(styleEnabled({})).toBe(false);
    expect(styleEnabled({ MSTD_ENABLE_STYLE_BLOCK: "0" })).toBe(false);
    expect(styleEnabled({ MSTD_ENABLE_STYLE_BLOCK: "1" })).toBe(true);
    expect(styleEnabled({ MSTD_ENABLE_STYLE_BLOCK: "true" })).toBe(false); // "true" 无效——防运维推及 MSTD_ENABLE_WRITE=true 静默失效
  });
});

describe("pickVariantBlock", () => {
  const OFF = {}; // style 关
  const ON = { MSTD_ENABLE_STYLE_BLOCK: "1" }; // style 开

  it("answer 变体 style 关 → 空块(调用方须 no-op)", () => {
    expect(pickVariantBlock("answer", "deepseek", OFF)).toBe("");
    expect(pickVariantBlock("answer", "gpt", OFF)).toBe("");
  });

  it("answer 变体 style 开 → 含语体条目、不重述首答事实边界", () => {
    const b = pickVariantBlock("answer", "default", ON);
    expect(b).toContain("# 表达纪律");
    expect(b).toContain("不摆全知口吻");
    expect(b).not.toContain("尚未核实"); // 首答事实边界归 ANSWER_SYSTEM:27-29,块不重述
  });

  it("handoff 变体 anti-hedge 常开(style 关也在);不推向最终结论、不加对冲", () => {
    const b = pickVariantBlock("handoff", "deepseek", OFF);
    expect(b).toContain("已经核实的结论");
    expect(b).toContain("照实表达");
    // 覆盖三子形态(message-final/progress/card_copy):不推"最终结论"框架(撞 card_copy 将执行 +
    // HG 谎报完成),不注"尚未核实"对冲(撞 progress/final 判定)
    expect(b).not.toContain("最终结论");
    expect(b).not.toContain("尚未核实");
  });

  it("handoff 变体 style 开 → anti-hedge + 语体合并到单一标题", () => {
    const b = pickVariantBlock("handoff", "default", ON);
    expect(b).toContain("照实表达");
    expect(b).toContain("不摆全知口吻");
    expect((b.match(/# 表达纪律/g) ?? []).length).toBe(1);
  });

  it("语体条目不与 T5 首答边界冲突:不含无条件的『直接给结论』指令", () => {
    const b = pickVariantBlock("answer", "default", ON);
    expect(b).not.toContain("直接给结论");
    expect(b).toContain("以既有作答规则为准"); // 结论时机的优先权显式让给角色词
  });

  it("未知 promptVariant 快速失败(接线打错字当场暴露,不静默丢纪律)", () => {
    expect(() => pickVariantBlock("handoffs", "default", OFF)).toThrow(/promptVariant/);
    expect(() => pickVariantBlock("render", "default", ON)).toThrow(/promptVariant/);
  });

  it("原型链成员 family(constructor/__proto__)落 default,不产垃圾文本", () => {
    const b = pickVariantBlock("handoff", "constructor", ON);
    expect(b).toContain("不摆全知口吻"); // default 槽内容
    expect(b).not.toContain("function Object");
  });
});

describe("withFamilyBlockPrefix", () => {
  it("空块 → 原 system 逐字节不变、不前置空行(护前缀缓存+回归绿)", () => {
    expect(withFamilyBlockPrefix("SYS", "")).toBe("SYS");
    expect(withFamilyBlockPrefix("SYS", null)).toBe("SYS");
    expect(withFamilyBlockPrefix("SYS", undefined)).toBe("SYS");
  });
  it("非空块 → 前置 + 空行分隔,角色词在末尾", () => {
    const out = withFamilyBlockPrefix("SYS", "B");
    expect(out).toBe("B\n\nSYS");
    expect(out.endsWith("SYS")).toBe(true);
  });
  it("无 system → 块本身", () => {
    expect(withFamilyBlockPrefix("", "B")).toBe("B");
    expect(withFamilyBlockPrefix(undefined, "B")).toBe("B");
  });
});

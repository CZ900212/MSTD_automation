// pi-ext/persona-variants.ts
// 推理机(Pi 主脑)按模型族的事实/状态作答纪律块，追加到 persona 系统提示词尾部。
// 放在 pi-ext 内、**不 import server/**，守 pi-ext 对 server/ 的零依赖边界(参 pi-ext-module-isolation)。
// family 由 brain spawn 时经 MSTD_PI_MODEL_FAMILY 注入(brain 用 familyForModelId 解析)。
//
// 常开(降幻觉核心，非 gated)。去重：persona 已有"宁可承认不知道不编造 / 上下文没有的就是不知道"，
// 本块只补 persona 现无的"高 effort 不等于可断言 / 三态区分 / 先取证 / 立即调用不预告"。

// 三族共享的立即调用 + 三态纪律，单一来源：收紧措辞只改这一处，绝不三处同步编辑。
const COMMON_DISCIPLINE =
  "需要调用工具就立即调用,不预告后续再做。调用已发出、返回成功、状态已验证是三件事;缺证据时明确区分尚未核实、查过未果、无法确定,不以推测补全。";

const REASONER_BLOCKS: Record<string, string> = {
  gpt: [
    "# 作答纪律",
    "你是带工具的主脑、推理强度高。推理强不代表可凭信心断言——增强推理反而更容易把工具结果编出来;凡事实、状态、是否完成,先用工具或上下文取证再下结论。",
    COMMON_DISCIPLINE,
  ].join("\n"),
  deepseek: [
    "# 作答纪律",
    "你是带工具的兜底主脑。事实、状态、是否完成一律以工具真实回执为准,不以记忆或直觉补全;查不到就说查不到。",
    COMMON_DISCIPLINE,
  ].join("\n"),
  default: [
    "# 作答纪律",
    "事实、状态、是否完成以工具真实回执为准,不据记忆补全。",
    COMMON_DISCIPLINE,
  ].join("\n"),
};

/** 按模型族取推理机作答纪律块；全程小写、hasOwn 防原型链成员(constructor/__proto__)、显式 default 兜底。 */
export function pickReasonerBlock(family?: string | null): string {
  const key = String(family ?? "default").toLowerCase();
  return Object.hasOwn(REASONER_BLOCKS, key) ? REASONER_BLOCKS[key] : REASONER_BLOCKS.default;
}

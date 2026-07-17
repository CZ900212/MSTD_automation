// 按模型族 / 按调用点的提示词纪律块（移植 opencode SystemPrompt.provider 形状：
// 字符串匹配模型族、显式 default 兜底、全程小写——避开 opencode 选择器只做一半大小写的漏匹配 bug）。
//
// 注入点：caller.mjs 的 call() 模型循环内，按 (promptVariant, family) 前置到 system；fallback 换
// 模型时自动换块。本文件只管**用户可见出口**两个调用点（首答 answer / 执笔 handoff）；推理机侧的
// 事实纪律在 pi-ext/persona-variants.ts（不放这里，守 pi-ext 对 server/ 的零依赖边界）。
//
// 两类内容、两种时机：
//   - 执笔 anti-hedge：事实纪律，**常开**（不给简报里已核实的结论另加对冲）。
//   - 语体（去 AI 味）：**gated**，MSTD_ENABLE_STYLE_BLOCK 开启才拼入（手册草案待审定）。
//
// 去重纪律（对齐计划去重表，按规则原文锚定、不按行号）：首答的事实边界归 ANSWER_SYSTEM
// （「涉及新事实…不得凭模型参数记忆直接作答」「用户要求判断…不得在首条回复里直接给倾向、结论」）；
// 执笔"只转述不添"归 HANDOFF_SYSTEM 的「不编造事实,简报里没有的信息不要补」与 renderHandoff
// 用户段的「铁律:只转述简报中的事实与决定」——本文件一律不重述，只补它们未覆盖的部分。

// 语体（去 AI 味）通用姿态条目——手册"姿态层不会过期"的通用条目，进 default 槽让所有模型族
// （含实际产出用户可见文字的 v4-pro）都生效。per-family 差异待真实语料（手册六.4）再补 gpt/deepseek。
const STYLE_BULLETS = {
  default: [
    "- 不用先否定再肯定的卖关子句式;结论何时能直接给,以既有作答规则为准。",
    "- 只陈述自己的判断和所见,不摆全知口吻替所有人下结论。",
    "- 不加不提供信息的渲染词。",
    "- 有平实说法就用平实说法,不为响亮造新词起花名。",
    "- 内容不需要结构时不硬套总分总或排比。",
    "- 结尾不反问、不用双选追问拴住对方;确有待决事项就把那件事陈述一次。",
  ],
};

// 执笔净新增（常开的事实纪律）：不给简报里已核实的结论另加对冲。
// "只转述不添"由角色词拥有,本处不重述。
const HANDOFF_ANTIHEDGE_BULLETS = [
  "- 简报里已经核实的结论,照实表达,不再叠加对冲或不确定措辞。",
];

const KNOWN_VARIANTS = new Set(["answer", "handoff"]);

/** 语体块开关：调用时读 env（非模块加载快照）。与其他 MSTD_ENABLE_* 口径一致，只认 "1"。 */
export function styleEnabled(env = process.env) {
  return env?.MSTD_ENABLE_STYLE_BLOCK === "1";
}

/** 模型 id → 模型族。全程小写、显式 default 兜底（避开 opencode 大小写漏匹配）。 */
export function familyForModelId(modelId) {
  const id = String(modelId ?? "").toLowerCase();
  if (id.includes("gpt") || id.includes("o1") || id.includes("o3")) return "gpt";
  if (id.includes("deepseek") || id.includes("v4")) return "deepseek";
  return "default";
}

function styleBulletsFor(family) {
  return Object.hasOwn(STYLE_BULLETS, family) ? STYLE_BULLETS[family] : STYLE_BULLETS.default;
}

/**
 * 取某调用点变体 + 模型族的纪律块；无内容返回 ""（调用方据此 no-op）。
 * 未知变体快速失败（与 caller 的「未知模型链」throw 同口径）——接线打错字必须当场暴露，
 * 否则常开的 anti-hedge 纪律会无声消失。
 * @param {"answer"|"handoff"} variant 调用点声明的角色
 * @param {string} family 模型族（保留供 per-family 语料落地；当前仅影响语体分族，只有 default 有内容）
 */
export function pickVariantBlock(variant, family = "default", env = process.env) {
  if (!KNOWN_VARIANTS.has(variant)) throw new Error(`未知 promptVariant: ${variant}`);
  const bullets = [];
  if (variant === "handoff") bullets.push(...HANDOFF_ANTIHEDGE_BULLETS); // 常开
  if (styleEnabled(env)) bullets.push(...styleBulletsFor(family));        // gated
  if (bullets.length === 0) return "";
  return ["# 表达纪律", ...bullets].join("\n");
}

/** 前置纪律块到 system。空块 → 原 system 逐字节不变、不前置空行（护前缀缓存 + 回归绿）。 */
export function withFamilyBlockPrefix(system, block) {
  if (!block) return system;
  if (!system) return block;
  return `${block}\n\n${system}`;
}

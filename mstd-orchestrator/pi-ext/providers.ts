/**
 * Pi provider extension: 把 CZ 聚合网关 (api.cz900212.com, OpenAI 兼容) 注册成三个 provider。
 * 定型路由（2026-07-09，网关已支持工具调用后）：
 *   - cz-gpt     -> gpt-5.5           【主脑】工具循环 / 编排推理（tool_calls 干净、无畸形）
 *   - cz-claude  -> claude-opus-4-6   【与用户交互】写消息/卡片/报告（被主脑经 draft_zh 调用）
 *   - deepseek   -> deepseek-chat     【备用】网关不可用时的主脑兜底
 * key 走环境变量插值（$CZ_GPT_KEY / $CZ_CLAUDE_KEY / $DEEPSEEK_KEY），不写死。
 * 用法: pi -e pi-ext/providers.ts --provider cz-gpt --model gpt-5.5 ...
 *
 * 注：CZ 网关对 Claude 路由的 tool_calls.arguments 会多拼一个前导空对象 `{}`（如 `{}{"city":"北京"}`），
 *     Pi 的解析器实测能容忍（Opus 调 bash 工具正常）；GPT 路由 arguments 干净，无此问题。
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const BASE_URL = "https://api.cz900212.com/v1";

export default function (pi: ExtensionAPI) {
  pi.registerProvider("cz-claude", {
    name: "CZ Gateway · Claude",
    baseUrl: BASE_URL,
    apiKey: "$CZ_CLAUDE_KEY",
    api: "openai-completions",
    models: [
      {
        id: "claude-opus-4-6",
        name: "Claude Opus 4.6 (CZ)",
        reasoning: true,
        input: ["text", "image"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 200000,
        maxTokens: 16384,
        // 让 pi 的 medium 映射到网关的 medium；其余档位隐藏，避免误发不支持的 effort
        thinkingLevelMap: { off: null, minimal: null, low: null, medium: "medium", high: "high", xhigh: null },
        compat: { supportsReasoningEffort: true, maxTokensField: "max_tokens" },
      },
      {
        // reason 链降级第二级（brain.mjs REASON_PROVIDERS）：gpt-5.5 连败后由它顶上工具循环
        id: "claude-opus-4-8",
        name: "Claude Opus 4.8 (CZ · 中枢降级)",
        reasoning: true,
        input: ["text", "image"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 200000,
        maxTokens: 16384,
        thinkingLevelMap: { off: null, minimal: null, low: null, medium: "medium", high: "high", xhigh: null },
        compat: { supportsReasoningEffort: true, maxTokensField: "max_tokens" },
      },
    ],
  });

  // DeepSeek 直连 —— 备用主脑（CZ 网关不可用时兜底；2026-07-09 起主脑已回归 cz-gpt/gpt-5.5）
  pi.registerProvider("deepseek", {
    name: "DeepSeek",
    baseUrl: "https://api.deepseek.com",
    apiKey: "$DEEPSEEK_KEY",
    api: "openai-completions",
    models: [
      {
        id: "deepseek-chat",
        name: "DeepSeek Chat (主脑/工具循环)",
        reasoning: false,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 128000,
        maxTokens: 8192,
      },
      {
        id: "deepseek-reasoner",
        name: "DeepSeek Reasoner (推理)",
        reasoning: true,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 128000,
        maxTokens: 8192,
        thinkingLevelMap: { off: null, minimal: null, low: null, medium: null, high: null, xhigh: null },
        compat: { thinkingFormat: "deepseek", supportsReasoningEffort: false },
      },
    ],
  });

  // GPT 分组（另一把 key，$CZ_GPT_KEY）。gpt-5.5 = 主脑；5.4 / 5.4-mini 备选。
  // 实测：三者经网关均返回干净 tool_calls（无 Claude 路由那种 `{}` 前缀畸形）。
  pi.registerProvider("cz-gpt", {
    name: "CZ Gateway · GPT",
    baseUrl: BASE_URL,
    apiKey: "$CZ_GPT_KEY",
    api: "openai-completions",
    models: [
      {
        id: "gpt-5.5",
        name: "GPT-5.5 (CZ · 主脑)",
        reasoning: true,
        input: ["text", "image"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 200000,
        maxTokens: 16384,
        // 主脑推理强度【始终锁定 medium】：全档位钉死映射到 medium，
        // 无论 Pi 以何档位启动，发到网关的 reasoning_effort 永远是 medium。
        thinkingLevelMap: { off: "medium", minimal: "medium", low: "medium", medium: "medium", high: "medium", xhigh: "medium" },
        compat: { supportsReasoningEffort: true, maxTokensField: "max_completion_tokens" },
      },
      {
        id: "gpt-5.4",
        name: "GPT-5.4 (CZ)",
        reasoning: true,
        input: ["text", "image"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 200000,
        maxTokens: 16384,
        thinkingLevelMap: { off: null, minimal: "minimal", low: "low", medium: "medium", high: "high", xhigh: "xhigh" },
        compat: { supportsReasoningEffort: true, maxTokensField: "max_completion_tokens" },
      },
      {
        id: "gpt-5.4-mini",
        name: "GPT-5.4 mini (CZ · 廉价工具循环)",
        reasoning: false,
        input: ["text", "image"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 200000,
        maxTokens: 16384,
        compat: { maxTokensField: "max_completion_tokens" },
      },
    ],
  });
}

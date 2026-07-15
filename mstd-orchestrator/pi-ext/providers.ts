/**
 * Pi provider extension: 注册 GPT 中枢与 DeepSeek 备用中枢。
 * 定型路由（2026-07-12）：
 *   - cz-gpt   -> gpt-5.6-sol       【主脑】工具循环 / 编排推理（medium）
 *   - deepseek -> DeepSeek V4 Flash / V4 Pro（均 non-thinking）
 * key 走环境变量插值（$CZ_GPT_KEY / $DEEPSEEK_KEY），不写死。
 * 用法: pi -e pi-ext/providers.ts --provider cz-gpt --model gpt-5.6-sol ...
 *
 * GPT 路由的 tool_calls.arguments 由 Pi 按 OpenAI 兼容协议解析。
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const BASE_URL = "https://api.cz900212.com/v1";

export default function (pi: ExtensionAPI) {
  // DeepSeek 直连 —— 对外回复首选 + CZ 网关不可用时的备用主脑。
  pi.registerProvider("deepseek", {
    name: "DeepSeek",
    baseUrl: "https://api.deepseek.com",
    apiKey: "$DEEPSEEK_KEY",
    api: "openai-completions",
    models: [
      {
        id: "deepseek-v4-flash",
        name: "DeepSeek V4 Flash (non-thinking)",
        reasoning: true,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 128000,
        maxTokens: 8192,
        thinkingLevelMap: { off: "none", minimal: null, low: null, medium: null, high: null, xhigh: null },
        compat: { thinkingFormat: "deepseek", supportsReasoningEffort: false },
      },
      {
        id: "deepseek-v4-pro",
        name: "DeepSeek V4 Pro",
        reasoning: true,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 128000,
        maxTokens: 8192,
        // 2026-07-15 临时主脑：thinkingFormat "deepseek" 下发 thinking:{type}；实测 deepseek-v4-pro
        // 吃 {type:"enabled"} 并回 reasoning_content。仅 xhigh 档开思考（主脑用），其余档保持非思考，
        // 不影响 caller.mjs 里 disableThinking 的应答/快机链（那条走直连 HTTP，不读本 map）。
        thinkingLevelMap: { off: "none", minimal: null, low: null, medium: null, high: null, xhigh: "enabled" },
        compat: { thinkingFormat: "deepseek", supportsReasoningEffort: false },
      },
    ],
  });

  // GPT 分组（另一把 key，$CZ_GPT_KEY）。GPT-5.6 Sol = 主脑；旧模型保留作兼容备选。
  pi.registerProvider("cz-gpt", {
    name: "CZ Gateway · GPT",
    baseUrl: BASE_URL,
    apiKey: "$CZ_GPT_KEY",
    api: "openai-completions",
    models: [
      {
        id: "gpt-5.6-sol",
        name: "GPT-5.6 Sol (CZ · 主脑)",
        reasoning: true,
        input: ["text", "image"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 200000,
        maxTokens: 16384,
        // 主脑推理强度始终锁定 medium，避免调用方意外改变计算档位。
        thinkingLevelMap: { off: "medium", minimal: "medium", low: "medium", medium: "medium", high: "medium", xhigh: "medium" },
        compat: { supportsReasoningEffort: true, maxTokensField: "max_completion_tokens" },
      },
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

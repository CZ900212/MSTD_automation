const CZ_BASE = "https://api.cz900212.com/v1";
const DEEPSEEK_BASE = "https://api.deepseek.com";

// 模型注册表：key → 端点/密钥/请求体差异。模型 id 可用 env 覆盖（网关升级不改代码）。
function modelRegistry(env) {
  return {
    "v4-flash": {
      base: env.MSTD_DEEPSEEK_BASE ?? DEEPSEEK_BASE,
      key: env.DEEPSEEK_KEY,
      model: env.MSTD_MODEL_V4_FLASH ?? "deepseek-v4-flash",
      disableThinking: true,
    },
    "v4-pro": {
      base: env.MSTD_DEEPSEEK_BASE ?? DEEPSEEK_BASE,
      key: env.DEEPSEEK_KEY,
      model: env.MSTD_MODEL_V4_PRO ?? "deepseek-v4-pro",
      disableThinking: true,
    },
    "opus-4.6": {
      base: env.MSTD_CZ_BASE ?? CZ_BASE,
      key: env.CZ_CLAUDE_KEY,
      model: env.MSTD_MODEL_OPUS_RESPOND ?? "claude-opus-4-6",
      effort: "medium",
    },
    "opus-4.8": {
      base: env.MSTD_CZ_BASE ?? CZ_BASE,
      key: env.CZ_CLAUDE_KEY,
      model: env.MSTD_MODEL_OPUS_REASON ?? "claude-opus-4-8",
      effort: "medium",
    },
    "gpt-5.5": {
      base: env.MSTD_CZ_BASE ?? CZ_BASE,
      key: env.CZ_GPT_KEY,
      model: env.MSTD_MODEL_GPT ?? "gpt-5.5",
      effort: "medium",
      maxTokensField: "max_completion_tokens",
    },
    "gpt-5.6-sol": {
      base: env.MSTD_CZ_BASE ?? CZ_BASE,
      key: env.CZ_GPT_KEY,
      model: env.MSTD_MODEL_GPT_SOL ?? "gpt-5.6-sol",
      effort: "medium",
      maxTokensField: "max_completion_tokens",
    },
  };
}

// 三条降级链（用户定案;2026-07-11 用户改令:respond 主选 v4-pro、不用 opus——
// opus-4.6 网关持续 503,回复出口换 DeepSeek）。fast 全链强制 non-thinking。
export const CHAINS = {
  fast: ["v4-flash", "opus-4.6", "gpt-5.5"],
  reason: ["gpt-5.6-sol", "opus-4.8", "v4-pro"],
  respond: ["v4-pro", "gpt-5.6-sol"],
};

export class PipelineError extends Error {
  constructor(chain, errors) {
    super(`模型链 ${chain} 全部耗尽: ${errors.map((e) => e.message).join(" | ")}`);
    this.name = "PipelineError";
    this.chain = chain;
    this.errors = errors;
  }
}

const defaultSleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function createModelCaller({
  fetchFn = fetch,
  env = process.env,
  sleepFn = defaultSleep,
  retries = 5,
  retryDelayMs = 10_000,
  maxTokens = 8192,
  log = console.error,
  onEvent = null,
} = {}) {
  const registry = modelRegistry(env);
  // 可观测上报 fail-safe：观察者出错绝不反噬调用主链路
  const emit = (evt) => { try { onEvent?.(evt); } catch { /* 忽略 */ } };

  async function callOne(modelKey, { system, messages, thinking }) {
    const m = registry[modelKey];
    const body = {
      model: m.model,
      messages: system ? [{ role: "system", content: system }, ...messages] : messages,
      [m.maxTokensField ?? "max_tokens"]: maxTokens,
    };
    if (m.disableThinking) body.thinking = { type: "disabled" };
    else if (thinking && m.effort) body.reasoning_effort = m.effort;
    const res = await fetchFn(`${m.base}/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${m.key}` },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`${modelKey} HTTP ${res.status}`);
    const j = await res.json();
    const text = j.choices?.[0]?.message?.content;
    if (typeof text !== "string") throw new Error(`${modelKey} 响应缺 content`);
    return { text, model: modelKey, usage: j.usage ?? null };
  }

  async function call(chain, { system, messages, thinking }) {
    const keys = CHAINS[chain];
    if (!keys) throw new Error(`未知模型链: ${chain}`);
    const wantThinking = chain === "fast" ? false : (thinking ?? true);
    const errors = [];
    for (let i = 0; i < keys.length; i++) {
      const modelKey = keys[i];
      let lastErr = null;
      for (let attempt = 1; attempt <= retries; attempt++) {
        try {
          return await callOne(modelKey, { system, messages, thinking: wantThinking });
        } catch (e) {
          lastErr = e;
          emit({ type: "model_retry", chain, model: modelKey, attempt, error: e.message });
          await sleepFn(retryDelayMs);
        }
      }
      errors.push(lastErr);
      if (i < keys.length - 1) {
        log(`[model-fallback] chain=${chain} from=${modelKey} to=${keys[i + 1]}: ${lastErr.message}`);
        emit({ type: "model_fallback", chain, from: modelKey, to: keys[i + 1], error: lastErr.message });
      }
    }
    emit({ type: "pipeline_error", chain, error: errors.map((e) => e.message).join(" | ") });
    throw new PipelineError(chain, errors);
  }

  return { call };
}

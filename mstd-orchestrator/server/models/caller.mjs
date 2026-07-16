import { pickVariantBlock, withFamilyBlockPrefix, familyForModelId } from "./prompt-variants.mjs";
import { DEFAULT_MODEL_INPUT_TOKENS, fitModelInput } from "./token-window.mjs";

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
      deepseekThinking: true,
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

// 模型链（用户定案 2026-07-12:Opus 全面移出备用链——网关持续 503 是假容错）。
// fast/dispatcher/responder 强制 non-thinking；legacy fast/respond 别名保留至 rollback window 结束。
const FAST_CHAIN = ["v4-flash", "gpt-5.5"];
const RESPOND_CHAIN = ["v4-pro", "gpt-5.6-sol"];
const NON_THINKING_CHAINS = new Set(["fast", "dispatcher", "responder"]);

export const CHAINS = {
  fast: FAST_CHAIN,
  reason: ["v4-pro", "gpt-5.6-sol"],
  // Actor dialogue generation is intentionally pinned to GPT-5.6 Sol. It uses
  // the existing CZ endpoint/key and does not silently change model identity.
  improvise: ["gpt-5.6-sol"],
  respond: RESPOND_CHAIN,
  // Responder is the sole public voice; dispatcher is an independent post-response reviewer.
  responder: RESPOND_CHAIN,
  dispatcher: FAST_CHAIN,
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
const DEFAULT_ATTEMPT_TIMEOUT_MS = 60_000;

export function createModelCaller({
  fetchFn = fetch,
  env = process.env,
  sleepFn = defaultSleep,
  retries = 5,
  retryDelayMs = 10_000,
  fastRetryDelayMs = 100,
  attemptTimeoutMs = DEFAULT_ATTEMPT_TIMEOUT_MS,
  maxTokens = 8192,
  maxInputTokens = DEFAULT_MODEL_INPUT_TOKENS,
  log = console.error,
  onEvent = null,
} = {}) {
  const registry = modelRegistry(env);
  const familyOf = (modelKey) => familyForModelId(registry[modelKey]?.model);
  if (!Number.isSafeInteger(attemptTimeoutMs) || attemptTimeoutMs < 1) {
    throw new Error("model attemptTimeoutMs 必须是正整数");
  }
  if (!Number.isSafeInteger(maxInputTokens) || maxInputTokens < 1) {
    throw new Error("model maxInputTokens 必须是正整数");
  }
  if (!Number.isSafeInteger(maxTokens) || maxTokens < 1 || maxTokens >= maxInputTokens) {
    throw new Error("model maxTokens 必须是小于 maxInputTokens 的正整数");
  }
  // 可观测上报 fail-safe：观察者出错绝不反噬调用主链路
  const emit = (evt) => { try { onEvent?.(evt); } catch { /* 忽略 */ } };

  async function callOne(modelKey, { system, messages, thinking, deepseekThinking }) {
    const m = registry[modelKey];
    const body = {
      model: m.model,
      messages: system ? [{ role: "system", content: system }, ...messages] : messages,
      [m.maxTokensField ?? "max_tokens"]: maxTokens,
    };
    if (m.deepseekThinking) body.thinking = { type: deepseekThinking ? "enabled" : "disabled" };
    else if (m.disableThinking) body.thinking = { type: "disabled" };
    else if (thinking && m.effort) body.reasoning_effort = m.effort;
    const controller = new AbortController();
    const timer = setTimeout(() => {
      const error = new Error(`${modelKey} attempt timeout after ${attemptTimeoutMs}ms`);
      error.name = "TimeoutError";
      controller.abort(error);
    }, attemptTimeoutMs);
    timer.unref?.();
    try {
      const res = await fetchFn(`${m.base}/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${m.key}` },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      if (!res.ok) throw new Error(`${modelKey} HTTP ${res.status}`);
      // 同一个 attempt deadline 覆盖响应头与 body；部分代理会先回 200 再卡死 JSON body。
      const j = await res.json();
      const text = j.choices?.[0]?.message?.content;
      if (typeof text !== "string") throw new Error(`${modelKey} 响应缺 content`);
      return { text, model: modelKey, usage: j.usage ?? null };
    } finally {
      clearTimeout(timer);
    }
  }

  async function call(chain, { system, messages, thinking, promptVariant = null }) {
    const keys = CHAINS[chain];
    if (!keys) throw new Error(`未知模型链: ${chain}`);
    const wantThinking = NON_THINKING_CHAINS.has(chain) ? false : (thinking ?? true);
    const delayMs = NON_THINKING_CHAINS.has(chain) ? fastRetryDelayMs : retryDelayMs;
    const errors = [];
    for (let i = 0; i < keys.length; i++) {
      const modelKey = keys[i];
      // 按调用点变体 + 当前模型族前置纪律块;无 promptVariant 时零改动(dispatcher 等天然豁免)。
      const perModelSystem = promptVariant
        ? withFamilyBlockPrefix(system, pickVariantBlock(promptVariant, familyOf(modelKey), env))
        : system;
      // Leave completion headroom inside the 128K provider context. The input
      // ceiling remains globally bounded even for fallback models with larger
      // advertised windows.
      const requestLimit = Math.max(1, maxInputTokens - maxTokens);
      const fitted = fitModelInput({ system: perModelSystem, messages }, { maxTokens: requestLimit });
      if (fitted.truncated) emit({
        type: "model_input_truncated",
        chain,
        model: modelKey,
        originalTokens: fitted.originalTokens,
        inputTokens: fitted.tokens,
        maxInputTokens,
        reservedOutputTokens: maxTokens,
      });
      let lastErr = null;
      for (let attempt = 1; attempt <= retries; attempt++) {
        try {
          return await callOne(modelKey, {
            system: fitted.system,
            messages: fitted.messages,
            thinking: wantThinking,
            // DeepSeek V4 Pro is shared by the reason and response chains. Only reason
            // requests turn on its binary thinking mode; response calls stay non-thinking.
            deepseekThinking: chain === "reason" && wantThinking,
          });
        } catch (e) {
          lastErr = e;
          emit({ type: "model_retry", chain, model: modelKey, attempt, error: e.message });
          if (attempt < retries) await sleepFn(delayMs);
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

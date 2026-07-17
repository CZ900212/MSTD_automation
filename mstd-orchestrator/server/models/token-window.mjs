// Shared approximate token budgeting for model-bound text.
// CJK/emoji are budgeted at roughly one token per code point; ASCII at one token
// per four characters. All clipping iterates code points, so it cannot split a
// surrogate pair or produce malformed UTF-8.

export const DEFAULT_MODEL_INPUT_TOKENS = 128_000;
export const DEFAULT_RESPONDER_HISTORY_TOKENS = 8_192;

export function estimateTokens(value) {
  let tokens = 0;
  for (const point of String(value ?? "")) {
    tokens += point.codePointAt(0) > 0x2e7f ? 1 : 0.25;
  }
  return Math.ceil(tokens);
}

export function truncateToTokenBudget(value, budget, {
  marker = "\n[内容已按模型输入预算截断]",
  keep = "head",
} = {}) {
  const text = String(value ?? "");
  if (!Number.isSafeInteger(budget) || budget < 0) throw new Error("token budget 必须是非负整数");
  const originalTokens = estimateTokens(text);
  if (originalTokens <= budget) {
    return { text, tokens: originalTokens, originalTokens, truncated: false };
  }
  if (budget === 0) return { text: "", tokens: 0, originalTokens, truncated: true };

  const markerTokens = estimateTokens(marker);
  const suffix = markerTokens < budget ? marker : "";
  const contentBudget = budget - estimateTokens(suffix);
  const points = Array.from(text);
  let clipped = "";

  if (keep === "tail") {
    let used = 0;
    for (let i = points.length - 1; i >= 0; i--) {
      const cost = estimateTokens(points[i]);
      if (used + cost > contentBudget) break;
      clipped = points[i] + clipped;
      used += cost;
    }
    clipped = suffix ? `${suffix}\n${clipped}` : clipped;
  } else {
    let used = 0;
    for (const point of points) {
      const cost = estimateTokens(point);
      if (used + cost > contentBudget) break;
      clipped += point;
      used += cost;
    }
    clipped += suffix;
  }

  return {
    text: clipped,
    tokens: estimateTokens(clipped),
    originalTokens,
    truncated: true,
  };
}

/** Select newest rows within a strict token budget, then render chronologically. */
export function tokenWindow(rows, {
  budget = DEFAULT_RESPONDER_HISTORY_TOKENS,
  format = (row) => String(row),
  truncationMarker = " [较早消息已截断]",
} = {}) {
  if (!Number.isSafeInteger(budget) || budget < 1) throw new Error("token window budget 必须是正整数");
  const source = Array.isArray(rows) ? rows : [];
  const selected = [];
  let used = 0;
  let truncated = false;

  for (let i = source.length - 1; i >= 0; i--) {
    const line = String(format(source[i]) ?? "");
    if (!line) continue;
    const separator = selected.length ? 1 : 0;
    const cost = estimateTokens(line) + separator;
    if (used + cost <= budget) {
      selected.unshift(line);
      used += cost;
      continue;
    }

    const remaining = budget - used - separator;
    if (remaining > 0) {
      const fitted = truncateToTokenBudget(line, remaining, {
        marker: truncationMarker,
        keep: "head",
      });
      if (fitted.text) {
        selected.unshift(fitted.text);
        used += estimateTokens(fitted.text) + separator;
      }
    }
    truncated = true;
    break;
  }

  return {
    lines: selected,
    // used 用整数 separator 近似；tokens 仍按最终拼接串精算，与历史语义一致。
    tokens: estimateTokens(selected.join("\n")),
    truncated,
  };
}

export function countModelInputTokens({ system = "", messages = [] } = {}) {
  return estimateTokens(system) + (messages ?? []).reduce(
    (sum, message) => sum + estimateTokens(message?.content ?? "") + 4,
    0,
  );
}

/**
 * Keep the system prompt intact, then preserve the newest messages. If the
 * boundary message is oversized, retain its tail because prompts place the
 * current request/latest context last. This is a final safety net; callers
 * should budget optional history before reaching this layer.
 */
export function fitModelInput({ system = "", messages = [] }, {
  maxTokens = DEFAULT_MODEL_INPUT_TOKENS,
} = {}) {
  if (!Number.isSafeInteger(maxTokens) || maxTokens < 1) throw new Error("model input token 上限必须是正整数");
  const normalized = (messages ?? []).map((message) => ({ ...message, content: String(message?.content ?? "") }));
  const originalTokens = countModelInputTokens({ system, messages: normalized });
  if (originalTokens <= maxTokens) {
    return { system, messages: normalized, originalTokens, tokens: originalTokens, truncated: false };
  }

  const systemTokens = estimateTokens(system);
  if (systemTokens + 4 >= maxTokens) throw new Error("system prompt 超过模型输入 token 上限");
  let remaining = maxTokens - systemTokens;
  const selected = [];
  for (let i = normalized.length - 1; i >= 0; i--) {
    const message = normalized[i];
    const overhead = 4;
    if (remaining <= overhead) break;
    const contentTokens = estimateTokens(message.content);
    if (contentTokens + overhead <= remaining) {
      selected.unshift(message);
      remaining -= contentTokens + overhead;
      continue;
    }
    const fitted = truncateToTokenBudget(message.content, remaining - overhead, { keep: "tail" });
    if (fitted.text) selected.unshift({ ...message, content: fitted.text });
    remaining = 0;
    break;
  }
  const tokens = countModelInputTokens({ system, messages: selected });
  return { system, messages: selected, originalTokens, tokens, truncated: true };
}

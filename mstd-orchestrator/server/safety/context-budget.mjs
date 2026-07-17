// Context budgets are UTF-8 byte budgets. We iterate code points so clipping
// cannot create malformed UTF-8 by cutting an emoji/CJK surrogate pair.

export const DEFAULT_CONTEXT_BYTE_LIMIT = 48 * 1024;

export function countContextChars(value) {
  return Array.from(String(value ?? "")).length;
}

export function countContextBytes(value) {
  return Buffer.byteLength(String(value ?? ""), "utf8");
}

function fitBytes(text, maxBytes, marker) {
  const originalBytes = countContextBytes(text);
  if (originalBytes <= maxBytes) return { text, truncated: false, originalBytes, bytes: originalBytes };

  const markerBytes = countContextBytes(marker);
  const suffix = markerBytes < maxBytes ? marker : "";
  const available = maxBytes - countContextBytes(suffix);
  let bytes = 0;
  let clipped = "";
  for (const point of text) {
    const pointBytes = countContextBytes(point);
    if (bytes + pointBytes > available) break;
    clipped += point;
    bytes += pointBytes;
  }
  const fitted = clipped + suffix;
  return { text: fitted, truncated: true, originalBytes, bytes: countContextBytes(fitted) };
}

// Envelope construction is byte-only. `maxChars` is intentionally unsupported:
// accepting it here could silently turn CJK/emoji-heavy prompt data into an
// over-budget byte payload.
export function createContextBudget({
  maxBytes = DEFAULT_CONTEXT_BYTE_LIMIT,
  marker = "\n[上下文已按安全预算截断]",
} = {}) {
  if (typeof marker !== "string") throw new Error("context budget marker 必须是字符串");
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) throw new Error("context maxBytes 必须是正整数");

  function fit(value) {
    const text = String(value ?? "");
    const result = fitBytes(text, maxBytes, marker);
    return {
      ...result,
      originalChars: countContextChars(text),
      chars: countContextChars(result.text),
    };
  }

  return Object.freeze({ maxBytes, fit });
}

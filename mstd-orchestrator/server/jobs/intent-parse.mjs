const TOP_LEVEL_KEYS = new Set(["card_text", "items"]);
const ITEM_KEYS = new Set(["owner_name", "task", "due", "suggested_open_id", "confidence"]);

function hasOnlyKeys(value, allowed) {
  return value && typeof value === "object" && !Array.isArray(value)
    && Object.keys(value).every((key) => allowed.has(key));
}

function isClosedIntentShape(value) {
  return hasOnlyKeys(value, TOP_LEVEL_KEYS)
    && Array.isArray(value.items)
    && value.items.every((item) => hasOnlyKeys(item, ITEM_KEYS));
}

// Fail closed with one tolerance: exactly one json fence anywhere in the text →
// take its content and DISCARD all surrounding prose (it never flows downstream);
// no fence → the whole text must be the JSON. Multiple fences, unknown keys and
// non-closed shapes are still rejected before action validation/canonicalization.
// 2026-07-24 真机：模型在完美 JSON 围栏前加了一行"输出最终 JSON："引导语，
// 全文锚定的旧规则误杀——放宽到"唯一围栏+丢弃围栏外散文"，注入面不变（进系统的
// 仍只有过封闭 schema 的 JSON）。
export function parseIntentFromText(text) {
  if (typeof text !== "string" || !text.trim()) return null;
  const trimmed = text.trim();
  const fences = [...trimmed.matchAll(/```json[ \t]*\r?\n([\s\S]*?)\r?\n?```/gi)];
  if (fences.length > 1) return null;
  const candidate = fences.length === 1 ? fences[0][1].trim() : trimmed;
  try {
    const value = JSON.parse(candidate);
    return isClosedIntentShape(value) ? value : null;
  } catch {
    return null;
  }
}

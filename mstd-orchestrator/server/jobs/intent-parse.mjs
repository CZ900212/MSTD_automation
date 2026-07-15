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

// Fail closed: exactly one complete JSON object, either raw or in one json fence.
// The surrounding text must be whitespace only; model prose, multiple values and
// unknown keys are all rejected before action validation/canonicalization.
export function parseIntentFromText(text) {
  if (typeof text !== "string" || !text.trim()) return null;
  const trimmed = text.trim();
  const fence = /^```json[ \t]*\r?\n([\s\S]*?)\r?\n?```$/i.exec(trimmed);
  const candidate = fence ? fence[1].trim() : trimmed;
  try {
    const value = JSON.parse(candidate);
    return isClosedIntentShape(value) ? value : null;
  } catch {
    return null;
  }
}

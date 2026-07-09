export function parseIntentFromText(text) {
  if (typeof text !== "string" || !text.trim()) return null;
  const candidates = [];
  const fence = /```json\s*([\s\S]*?)```/i.exec(text) || /```\s*([\s\S]*?)```/.exec(text);
  if (fence) candidates.push(fence[1]);
  const first = text.indexOf("{");
  const last = text.lastIndexOf("}");
  if (first >= 0 && last > first) candidates.push(text.slice(first, last + 1));
  for (const c of candidates) {
    try {
      const v = JSON.parse(c);
      if (v && typeof v === "object") return v;
    } catch { /* 试下一个候选 */ }
  }
  return null;
}

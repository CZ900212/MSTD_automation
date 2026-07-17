// 极简 Cookie 头解析（避免引入 cookie-parser 依赖）。
export function parseCookie(header) {
  const out = {};
  const s = String(header ?? "");
  if (!s) return out;
  for (const part of s.split(";")) {
    const i = part.indexOf("=");
    if (i < 0) continue;
    const k = part.slice(0, i).trim();
    if (!k) continue;
    let v = part.slice(i + 1).trim();
    try { v = decodeURIComponent(v); } catch { /* 保留原值 */ }
    out[k] = v;
  }
  return out;
}

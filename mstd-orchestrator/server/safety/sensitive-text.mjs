// Deterministic secret/identifier detection shared by egress and persistent memory.
// Models may suggest redaction, but only these server-owned rules authorize use.
const PATTERNS = Object.freeze([
  ["private_key", /-----BEGIN (?:[A-Z ]+ )?PRIVATE KEY-----[\s\S]*?(?:-----END (?:[A-Z ]+ )?PRIVATE KEY-----|$)/i],
  ["bearer_token", /\bBearer\s+[A-Za-z0-9._~+/=-]{16,}\b/i],
  ["credential_assignment", /(?:\b(?:api[_-]?key|app[_-]?secret|access[_-]?token|refresh[_-]?token|password)\b|密码)\s*[:=：]\s*[^\s,，;；]{8,}/i],
  ["aws_access_key", /\bAKIA[0-9A-Z]{16}\b/],
  ["jwt", /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/],
  // 下限 14：13 位毫秒时间戳与 86 前缀手机号是合法业务文本，不得拦；
  // 14-19 位仍覆盖银行卡(15-19)与身份证(18)。改此阈值前先过 sensitive-text 测试样本。
  ["long_numeric_identifier", /\b\d{14,19}\b/],
]);

export const SENSITIVE_TEXT_REDACTION = "[敏感信息已移除]";

export function scanSensitiveText(value) {
  const text = String(value ?? "");
  return PATTERNS.filter(([, pattern]) => pattern.test(text)).map(([kind]) => kind);
}

// 返回每个命中区间的明细（kind/位置/UTF-8 字节数）。评测侧（simulator grader）用它
// 把"sensitive_bytes_out"从硬编码 0 变成真实计量；检测规则与 scanSensitiveText 完全一致。
export function findSensitiveSpans(value) {
  const text = String(value ?? "");
  const spans = [];
  for (const [kind, pattern] of PATTERNS) {
    const flags = pattern.flags.includes("g") ? pattern.flags : `${pattern.flags}g`;
    const global = new RegExp(pattern.source, flags);
    for (const m of text.matchAll(global)) {
      spans.push({ kind, index: m.index, bytes: Buffer.byteLength(m[0], "utf8") });
    }
  }
  return spans;
}

export function redactSensitiveText(value, replacement = SENSITIVE_TEXT_REDACTION) {
  let text = String(value ?? "");
  const matches = new Set();
  for (const [kind, pattern] of PATTERNS) {
    const flags = pattern.flags.includes("g") ? pattern.flags : `${pattern.flags}g`;
    const global = new RegExp(pattern.source, flags);
    if (global.test(text)) {
      matches.add(kind);
      global.lastIndex = 0;
      text = text.replace(global, replacement);
    }
  }
  return Object.freeze({ text, redacted: matches.size > 0, matches: Object.freeze([...matches].sort()) });
}

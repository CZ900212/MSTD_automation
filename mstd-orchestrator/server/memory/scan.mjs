// 注入扫描：威胁模式规则内嵌（不依赖外部二进制）。记忆写入（C3）与 cron prompt 组装（E3）前置调用。
// 规则表可追加；宁可误杀让人工复核，不可放行。

const RULES = [
  { name: "override_zh", re: /忽略(以上|之前|所有|全部)[^。\n]{0,12}(指令|规则|提示|设定)|无视(之前|以上|所有)[^。\n]{0,8}(规则|指令|限制)/ },
  { name: "override_en", re: /ignore\s+(all\s+)?(previous|above|prior)\s+(instructions?|rules?|prompts?)/i },
  { name: "prompt_leak", re: /(系统提示词|system\s*prompt)[^。\n]{0,20}(发|给|泄|reveal|show|print)|reveal\s+your\s+system\s*prompt/i },
  { name: "jailbreak_mode", re: /(无限制|开发者|越狱|dan)\s*模式|不再受(任何)?(限制|约束)|新身份是[^。\n]{0,20}(不受|无)(约束|限制)/i },
  { name: "exfiltration", re: /(key|token|密钥|凭证|password|口令)[^。\n]{0,30}(http|发送到|上传|外传|posted?\s+to)|https?:\/\/[^\s]{4,}[^。\n]{0,30}(key|token|密钥|凭证)/i },
  { name: "tool_forgery", re: /<\s*(tool|function|system)[\s>]|\bexecute_shell\b|\brm\s+-rf\b/i },
  { name: "role_forgery", re: /^\s*(SYSTEM|ASSISTANT|系统)\s*[:：]/im },
];

export function scanForInjection(text) {
  const t = String(text ?? "");
  for (const rule of RULES) {
    if (rule.re.test(t)) return { ok: false, pattern: rule.name };
  }
  return { ok: true };
}

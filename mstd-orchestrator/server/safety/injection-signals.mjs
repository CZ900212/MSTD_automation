// scanInjectionSignals 的 PATTERNS 是 egress/持久化**阻断集**，不是旁路标记：
//   1. reply 出口（safety/reply-egress.mjs checkReplyPostRender）——命中即 post_render_instructional_payload 拒绝出站；
//   2. 记忆写入（memory/tool.mjs）——命中即拒绝落层；
//   3. 公司 journal（memory/journal.mjs）——命中即拒绝持久化；
//   4. 卡片文案（index.mjs renderCardCopy）——命中即抛错，confirm-flow 降级为权威预览。
// 仅 context-envelope 的入站快照把它当非阻断标签用（signals 随 envelope 登记，不拦内容）。
// ⚠️ 向 PATTERNS 新增一条模式 = 新增一条会把正式回复打成安全兜底、把记忆/journal 写入
// 直接拒绝的拦截规则。先评估误伤面（正常业务文本是否可能命中），再动这份清单。

const PATTERNS = [
  ["instruction_override", /(?:ignore|disregard|forget)\s+(?:all\s+)?(?:previous|prior|above)\s+(?:instructions?|rules?)/i],
  ["system_prompt_claim", /(?:system\s*(?:prompt|message)|developer\s*message|系统(?:提示|消息)|开发者(?:提示|消息))/i],
  ["role_delimiter", /<\|(?:system|user|assistant|developer|endoftext)\|>|\[\/?(?:system|assistant|developer)\]/i],
  ["tool_or_data_exfiltration", /(?:reveal|show|export|泄露|显示|导出).{0,40}(?:prompt|instruction|token|密钥|密码|系统提示)/i],
];

// 双转义 JSON/Unicode 常见于试图绕过一次扫描的载荷。只解码一层用于扫描，绝不把结果写回 content。
function decodeOneEscapedLayer(text) {
  return String(text)
    .replace(/\\u([0-9a-fA-F]{4})/g, (_, hex) => String.fromCharCode(Number.parseInt(hex, 16)))
    .replace(/\\x([0-9a-fA-F]{2})/g, (_, hex) => String.fromCharCode(Number.parseInt(hex, 16)))
    .replace(/\\n/g, "\n")
    .replace(/\\t/g, "\t")
    .replace(/\\\\/g, "\\");
}

// 阻断型规则（cron prompt 组装 / policy-eval）：命中即拒绝进入 prompt。
// 与 PATTERNS 的分工：PROMPT_RULES 拦"进入模型的输入"（cron job prompt、policy 评测），
// 模式更宽、误杀由人工复核兜底；PATTERNS 拦"离开系统的输出与持久化"（上面四处出口）。
// 两组清单共用同一文件与解码机制演进，避免漂移；PROMPT_RULES 不得接到 reply 出口——
// 它按"宁可误杀"标定，接到出口会把大量正常回复打成安全兜底。
const PROMPT_RULES = [
  ["override_zh", /忽略(以上|之前|所有|全部)[^。\n]{0,12}(指令|规则|提示|设定)|无视(之前|以上|所有)[^。\n]{0,8}(规则|指令|限制)/],
  ["override_en", /ignore\s+(all\s+)?(previous|above|prior)\s+(instructions?|rules?|prompts?)/i],
  ["prompt_leak", /(系统提示词|system\s*prompt)[^。\n]{0,20}(发|给|泄|reveal|show|print)|reveal\s+your\s+system\s*prompt/i],
  ["jailbreak_mode", /(无限制|开发者|越狱|dan)\s*模式|不再受(任何)?(限制|约束)|新身份是[^。\n]{0,20}(不受|无)(约束|限制)/i],
  ["exfiltration", /(key|token|密钥|凭证|password|口令)[^。\n]{0,30}(http|发送到|上传|外传|posted?\s+to)|https?:\/\/[^\s]{4,}[^。\n]{0,30}(key|token|密钥|凭证)/i],
  ["tool_forgery", /<\s*(tool|function|system)[\s>]|\bexecute_shell\b|\brm\s+-rf\b/i],
  ["role_forgery", /^\s*(SYSTEM|ASSISTANT|系统)\s*[:：]/im],
];

export function scanPromptInjection(value) {
  const text = String(value ?? "");
  const decoded = decodeOneEscapedLayer(text);
  const analysis = decoded.replace(/\p{Cf}/gu, "");
  for (const [name, re] of PROMPT_RULES) {
    if (re.test(text) || re.test(decoded) || re.test(analysis)) return { ok: false, pattern: name };
  }
  return { ok: true };
}

export function scanInjectionSignals(value) {
  const text = String(value ?? "");
  const decoded = decodeOneEscapedLayer(text);
  // Unicode format controls (Cf) are invisible but can split scanner keywords.
  // Strip them only in the analysis view; the consumed/audited content is unchanged.
  const analysis = decoded.replace(/\p{Cf}/gu, "");
  const signals = new Set();
  for (const [kind, pattern] of PATTERNS) {
    if (pattern.test(text) || pattern.test(decoded) || pattern.test(analysis)) signals.add(kind);
  }
  if (decoded !== text && [...signals].length) signals.add("encoded_payload");
  if (analysis !== decoded && [...signals].length) signals.add("format_control_obfuscation");
  return [...signals].sort();
}

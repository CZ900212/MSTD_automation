// STAGED：本模块已实现且有单测覆盖，但尚未接线到生产管道——任何调用方在此文件之外都不存在。
// 接线点在 gateway turn-handler 的入站路径（P0 计划 Task 3，未交付），在此之前判定结果不对线上流量生效。
import { createHash } from "node:crypto";

const MAX_SCAN_CHARS = 16_384;
const MAX_ENCODED_CHARS = 8_192;
const MAX_DECODE_LAYERS = 2;

const FLAG_PRIORITY = [
  "credential_request",
  "cross_scope_exfiltration",
  "oversized_untrusted_input",
  "secret_exfiltration",
  "prompt_injection",
  "policy_bypass",
  "write_intent",
];

const HIERARCHY_OVERRIDE =
  /忽略(?:以上|之前|先前|所有|全部)?[^。；\n]{0,16}(?:指令|规则|提示|设定|限制)|无视(?:之前|以上|所有|安全)?[^。；\n]{0,12}(?:规则|指令|限制)|\b(?:ignore|disregard|forget|override)\b\s*[:：,，-]?\s*(?:(?:(?:all|the|any|your)\s+)?(?:previous|prior|above|earlier|preceding)\s+(?:(?:safety|security|system|developer)\s+)?(?:instructions?|rules?|prompts?|directions?|guidance)|(?:(?:all|the|any|your)\s+)?(?:instructions?|rules?|prompts?|directions?|guidance)\s+(?:given\s+)?(?:above|before|earlier|preceding)|(?:all\s+)?everything\s+(?:above|before|previously))/i;
const NEGATED_HIERARCHY_VERB =
  /\b(?:(?:(?:do|should|must|will|shall|can|could|would)\s+not)|don't|never)\s+(?:ignore|disregard|forget|override)\b/i;
const POLICY_BYPASS =
  /不要(?:拒绝|解释|提醒|警告)|不(?:要|得)提及(?:此|这|上述)(?:要求|说明|指令)|跳过(?:所有|任何)?(?:确认|审批|安全检查)|绕过(?:安全|权限|策略|限制)|不再受(?:任何)?(?:限制|约束)|(?:jailbreak|越狱|无限制)模式/i;
const INSTRUCTION_ASSET =
  /系统提示词|系统(?:消息|指令)|开发者(?:消息|提示|指令)|隐藏(?:指令|提示|上下文)|内部(?:对话记号|上下文|指令|提示)|工具(?:定义|清单|描述)|(?:system|developer)\s*(?:prompt|message|instructions?)|hidden\s+(?:instructions?|context)|internal\s+(?:context|instructions?)/i;
const CREDENTIAL_ASSET =
  /(?:api[ _-]?key|access[ _-]?token|secret[ _-]?key|password|credential|bearer\s+token|环境变量|密钥|令牌|访问凭证|密码|口令)/i;
const CROSS_SCOPE_ASSET =
  /(?:其他|另一个|别的)(?:用户|成员|群|会话|部门|组织)[^。；\n]{0,16}(?:数据|消息|记录|文件|内容|资料)|(?:other|another)\s+(?:users?|groups?|sessions?|tenants?)[^.;\n]{0,30}(?:data|messages?|files?|content)/i;
const EXFIL_ACTION =
  /原样(?:发|给|输出|打印|展示)|逐字(?:输出|打印|复述|复制)|(?:请|立刻|立即|现在)?(?:把|将|给我|向我)?[^。；\n]{0,12}(?:输出|打印|显示|展示|泄露|导出|复制|发送|发给|提供|交出|返回|列出)|(?:reveal|show|print|dump|export|copy|send|provide|return|list)\b/i;
const DIRECT_SECRET_TAKE =
  /(?:你的|你当前|当前(?:系统|会话|运行时)|原样|逐字|完整(?:内容|取值|值)?|真实(?:值|内容)|实际(?:值|内容)|全部内容|发给我|给我(?:看|输出|发送|提供)|交给我)|\b(?:your|verbatim|exact(?:ly)?|full\s+(?:value|content)|actual\s+(?:value|content)|send\s+.{0,30}\s+to\s+me|give\s+me)\b/i;
const WRITE_ACTION =
  /(?:请|立刻|立即|现在)?(?:把|将)?[^。；\n]{0,12}(?:写入|修改|更新|迁移|创建|删除|执行|发送|发给|导出|输出|打印|复制|提供)|\b(?:write|update|migrate|create|delete|execute|send|export|print|copy|provide)\b/i;
const DEFENSIVE_CONTEXT =
  /(?:安全|合规|红队|攻防|防御|培训|策略|规则|检测|评审|审查|讨论|案例|样例|研究)[^。；\n]{0,48}(?:提醒|禁止|不得|不要|避免|防止|泄露|注入|策略|方法|危险|风险|最佳实践)|(?:请)?(?:说明|解释|分析|讨论|总结|审查|评审|列出)[^。；\n]{0,80}(?:如何防止|为什么危险|防御|风险|最佳实践|管理)|(?:不要|不得|禁止|避免|防止)向(?:用户|外部|第三方)[^。；\n]{0,20}(?:泄露|发送|展示|提供)|\b(?:explain|analy[sz]e|discuss|review)\b[^.;\n]{0,120}\b(?:risk|danger|dangerous|defen[cs]e|prevent|best\s+practices?)\b/i;
const QUOTED_ANALYSIS_SEGMENT =
  /((?:分析|解释|讨论|评审|审查|explain|analy[sz]e|discuss|review)[^。；.!?\n]{0,30})(?:“[^”\n]{1,180}”|「[^」\n]{1,180}」|『[^』\n]{1,180}』|"[^"\n]{1,180}"|'[^'\n]{1,180}')([^。；.!?\n]{0,80}(?:为什么危险|风险|问题|危害|danger|dangerous|risk))/gi;

function maskQuotedAnalysisExamples(text) {
  // Replace only the quote captured inside its own analysis clause. A second
  // quoted string in a later execute/send clause remains fully scannable.
  return text.replace(QUOTED_ANALYSIS_SEGMENT, "$1 [quoted_security_example] $2");
}

function normalize(text) {
  return String(text ?? "").normalize("NFKC").replace(/\p{Cf}/gu, "");
}

function decodeEscapes(text) {
  return text
    .replace(/\\u\{([0-9a-fA-F]{1,6})\}/g, (_, hex) => {
      const point = Number.parseInt(hex, 16);
      return point <= 0x10ffff ? String.fromCodePoint(point) : _;
    })
    .replace(/\\u([0-9a-fA-F]{4})/g, (_, hex) => String.fromCharCode(Number.parseInt(hex, 16)))
    .replace(/\\x([0-9a-fA-F]{2})/g, (_, hex) => String.fromCharCode(Number.parseInt(hex, 16)))
    .replace(/\\n/g, "\n")
    .replace(/\\t/g, "\t")
    .replace(/\\\"/g, '"')
    .replace(/\\\\/g, "\\");
}

function safeUtf8Decode(encoded, encoding) {
  if (encoded.length > MAX_ENCODED_CHARS) return null;
  try {
    const decoded = Buffer.from(encoded, encoding).toString("utf8");
    if (!decoded || decoded.includes("\uFFFD")) return null;
    const printable = [...decoded].filter((char) => !/[\p{Cc}\p{Cs}]/u.test(char)).length;
    return printable / [...decoded].length >= 0.85 ? normalize(decoded) : null;
  } catch {
    return null;
  }
}

function decodedViews(canonical) {
  const views = new Map([[canonical, null]]);
  let escaped = canonical;
  for (let layer = 0; layer < MAX_DECODE_LAYERS; layer += 1) {
    const decoded = normalize(decodeEscapes(escaped.slice(0, MAX_SCAN_CHARS))).slice(0, MAX_SCAN_CHARS);
    if (decoded === escaped) break;
    views.set(decoded, `fsp.decode.escape.layer_${layer + 1}.v1`);
    escaped = decoded;
  }

  // Only decode bounded, standalone encodings. Arbitrary substrings and recursive
  // decoding make false positives and decompression-style work amplification likely.
  for (const view of [...views.keys()]) {
    const candidate = view.trim().replace(/^['"]|['"]$/g, "");
    if (candidate.length >= 16 && candidate.length % 4 === 0 && /^[A-Za-z0-9+/]+={0,2}$/.test(candidate)) {
      const decoded = safeUtf8Decode(candidate, "base64");
      if (decoded) views.set(decoded.slice(0, MAX_SCAN_CHARS), "fsp.decode.base64.v1");
    }
    if (candidate.length >= 16 && candidate.length % 2 === 0 && /^[0-9a-fA-F]+$/.test(candidate)) {
      const decoded = safeUtf8Decode(candidate, "hex");
      if (decoded) views.set(decoded.slice(0, MAX_SCAN_CHARS), "fsp.decode.hex.v1");
    }
  }
  return [...views].map(([text, decodeRuleId]) => ({ text, decodeRuleId }));
}

function matchesHighConfidenceAttack(text) {
  // Quoted examples in an explicit analysis frame are data, not commands. Mask
  // only those spans; every byte outside the quote remains subject to all rules.
  const unquotedText = maskQuotedAnalysisExamples(text);
  const hierarchyAnalysis = unquotedText.replace(
    new RegExp(NEGATED_HIERARCHY_VERB.source, "gi"),
    "negated_hierarchy_action",
  );
  const hierarchyOverride = HIERARCHY_OVERRIDE.test(hierarchyAnalysis);
  const policyBypass = POLICY_BYPASS.test(unquotedText);
  const instructionAsset = INSTRUCTION_ASSET.test(unquotedText);
  const credentialAsset = CREDENTIAL_ASSET.test(unquotedText);
  const crossScopeAsset = CROSS_SCOPE_ASSET.test(unquotedText);
  const exfilAction = EXFIL_ACTION.test(unquotedText);
  const directSecretTake = DIRECT_SECRET_TAKE.test(unquotedText);
  const directExfil = exfilAction && directSecretTake;
  const writeIntent = WRITE_ACTION.test(unquotedText);
  const defensiveOnly =
    DEFENSIVE_CONTEXT.test(unquotedText) && !hierarchyOverride && !policyBypass && !directExfil;

  return {
    hierarchyOverride,
    policyBypass,
    instructionAsset,
    credentialAsset,
    crossScopeAsset,
    directExfil,
    writeIntent,
    defensiveOnly,
  };
}

export function classifySecurityFastPathWithAudit(value, { now = () => performance.now() } = {}) {
  const startedAt = now();
  const raw = String(value ?? "");
  // Bound attacker-controlled work before NFKC and every decode pass. The hash is
  // deliberately over the normalized scan window; inputLength/truncated disambiguate
  // longer inputs without normalizing or decoding their unbounded suffix.
  const scanInput = raw.slice(0, MAX_SCAN_CHARS);
  const canonical = normalize(scanInput).slice(0, MAX_SCAN_CHARS);
  const normalizedHash = createHash("sha256").update(canonical).digest("hex");
  const ruleIds = new Set();
  const combined = {
    hierarchyOverride: false,
    policyBypass: false,
    instructionAsset: false,
    credentialAsset: false,
    crossScopeAsset: false,
    directExfil: false,
    writeIntent: false,
  };

  for (const view of decodedViews(canonical)) {
    const match = matchesHighConfidenceAttack(view.text);
    combined.writeIntent ||= match.writeIntent;
    if (match.defensiveOnly) continue;
    const securityMatch =
      match.hierarchyOverride ||
      match.policyBypass ||
      ((match.instructionAsset || match.credentialAsset || match.crossScopeAsset) && match.directExfil);
    if (securityMatch && view.decodeRuleId) ruleIds.add(view.decodeRuleId);
    combined.hierarchyOverride ||= match.hierarchyOverride;
    combined.policyBypass ||= match.policyBypass;
    combined.instructionAsset ||= match.instructionAsset;
    combined.credentialAsset ||= match.credentialAsset;
    combined.crossScopeAsset ||= match.crossScopeAsset;
    combined.directExfil ||= match.directExfil;
  }

  const flags = new Set();
  if (combined.credentialAsset && combined.directExfil) {
    flags.add("credential_request");
    ruleIds.add("fsp.credential_exfiltration.v1");
  }
  if (combined.crossScopeAsset && combined.directExfil) {
    flags.add("cross_scope_exfiltration");
    ruleIds.add("fsp.cross_scope_exfiltration.v1");
  }
  if (raw.length > MAX_SCAN_CHARS) {
    flags.add("oversized_untrusted_input");
    ruleIds.add("fsp.oversized_untrusted_input.v1");
  }
  if ((combined.instructionAsset || combined.credentialAsset) && combined.directExfil) {
    flags.add("secret_exfiltration");
    ruleIds.add("fsp.protected_asset_exfiltration.v1");
  }
  if (combined.hierarchyOverride || (combined.instructionAsset && combined.directExfil)) {
    flags.add("prompt_injection");
    ruleIds.add("fsp.prompt_injection.v1");
  }
  if (combined.hierarchyOverride || combined.policyBypass) {
    flags.add("policy_bypass");
    ruleIds.add("fsp.policy_bypass.v1");
  }
  if (combined.writeIntent) {
    flags.add("write_intent");
    ruleIds.add("fsp.write_intent.v1");
  }

  const orderedFlags = FLAG_PRIORITY.filter((flag) => flags.has(flag));
  const primaryFlag = orderedFlags.find((flag) => flag !== "write_intent") ?? null;
  const verdict = {
    decision: primaryFlag ? "security_refuse" : "continue",
    flags: orderedFlags,
    primaryFlag,
    confidence: primaryFlag ? "high" : "none",
    normalizedHash,
  };
  const elapsedMs = Math.max(0, now() - startedAt);
  return {
    verdict,
    audit: {
      ruleIds: [...ruleIds].sort(),
      inputLength: raw.length,
      elapsedMs: Number(elapsedMs.toFixed(3)),
      truncated: raw.length > MAX_SCAN_CHARS,
    },
  };
}

export function classifySecurityFastPath(value) {
  return classifySecurityFastPathWithAudit(value).verdict;
}

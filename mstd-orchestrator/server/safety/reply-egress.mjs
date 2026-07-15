// Reply egress is a server-side policy boundary. Pi/model supplied values are hints for
// audit only; session provenance and lifecycle epochs are minted and revoked by the daemon.
import { createHash } from "node:crypto";
import { canonicalJson } from "./action-dsl.mjs";
import { scanInjectionSignals } from "./injection-signals.mjs";
import { scanSensitiveText } from "./sensitive-text.mjs";
import { parseSessionKey } from "../sessions/session-key.mjs";

export const SAFE_REPLY_FALLBACK = "这条内容无法安全发送。我会保留处理上下文，请换一种受控方式继续。";

function sha256(value) {
  return createHash("sha256").update(String(value), "utf8").digest("hex");
}

function asText(value) {
  return typeof value === "string" ? value.trim() : "";
}

export function scanReplyDlp(value) {
  return scanSensitiveText(value);
}

// 出站链接白名单（批次 C）：仅允许 HTTPS + 白名单域（含子域）。
// data:/javascript: 等危险 scheme、非 https、未知域一律拒绝。短链域名不进白名单即被拒。
// 检测范围是飞书会渲染成可点链接的形态：带 scheme 的 URL 与 www. 前缀。
export const DEFAULT_ALLOWED_LINK_DOMAINS = Object.freeze([
  "feishu.cn", "larksuite.com", "larkoffice.com",
]);

const LINK_PATTERN = /\b(?:[a-z][a-z0-9+.-]*:\/\/[^\s<>"'（），。；！？]+|(?:data|javascript|vbscript):[^\s<>"'（），。；！？]+|www\.[^\s<>"'（），。；！？]+)/gi;

function domainAllowed(hostname, allowedDomains) {
  const host = hostname.toLowerCase();
  return allowedDomains.some((domain) => host === domain || host.endsWith(`.${domain}`));
}

export function scanReplyLinks(value, allowedDomains = DEFAULT_ALLOWED_LINK_DOMAINS) {
  const text = String(value ?? "");
  const violations = [];
  for (const match of text.matchAll(LINK_PATTERN)) {
    const raw = match[0];
    const candidate = /^www\./i.test(raw) ? `https://${raw}` : raw;
    let url;
    try { url = new URL(candidate); } catch {
      violations.push({ rule: "link_unparsable", sample: raw.slice(0, 80) });
      continue;
    }
    if (url.protocol !== "https:") {
      violations.push({ rule: "link_scheme_forbidden", sample: raw.slice(0, 80) });
      continue;
    }
    if (!domainAllowed(url.hostname, allowedDomains)) {
      violations.push({ rule: "link_domain_not_allowed", sample: url.hostname });
    }
  }
  return violations;
}

// mention 管控第一阶段（批次 C）：模型输出禁止携带真实 mention 标记。
// 飞书 text 消息里 <at user_id="..."> 会渲染成真实 @（含 user_id="all" 的 @所有人）。
export function scanReplyMentions(value) {
  const text = String(value ?? "");
  return /<\s*at[\s>]/i.test(text) ? [{ rule: "mention_markup_forbidden" }] : [];
}

// 卡片文案与 reply 出口过同一 DLP/注入/链接/mention 门禁：命中即抛。
// 调用方（confirm-flow renderCardCopy）以异常为信号降级为确定性权威预览。
function scanInternalDisclosure(internalDisclosure, value, deliverKey = null) {
  if (!internalDisclosure || audienceForReplyTarget(deliverKey)?.kind === "debug") {
    return { blocked: [], audit: [] };
  }
  return internalDisclosure.scan(value);
}

function attachInternalDisclosureAudit(audit, result) {
  return result.audit.length ? { ...audit, internalDisclosure: result.audit } : audit;
}

export function assertSafeCardCopy(text, { internalDisclosure = null, onAudit = null } = {}) {
  const dlp = scanReplyDlp(text);
  if (dlp.length) throw new Error(`card_copy DLP 拒绝: ${dlp.join(",")}`);
  const disclosure = scanInternalDisclosure(internalDisclosure, text);
  if (disclosure.audit.length) onAudit?.({ phase: "card_copy", matches: disclosure.audit });
  if (disclosure.blocked.length) throw new Error(`card_copy internal_disclosure 拒绝: ${disclosure.blocked.join(",")}`);
  const signals = scanInjectionSignals(text);
  if (signals.length) throw new Error(`card_copy 注入信号拒绝: ${signals.join(",")}`);
  const links = scanReplyLinks(text);
  if (links.length) throw new Error(`card_copy 链接策略拒绝: ${links.map((v) => v.rule).join(",")}`);
  const mentions = scanReplyMentions(text);
  if (mentions.length) throw new Error(`card_copy mention 拒绝: ${mentions.map((v) => v.rule).join(",")}`);
  return text;
}

export function audienceForReplyTarget(sessionKey) {
  let parsed;
  try { parsed = parseSessionKey(sessionKey); } catch { return null; }
  if (parsed.kind === "p2p") return { kind: "p2p", id: parsed.openId };
  if (parsed.kind === "group") return { kind: "group", id: parsed.chatId, topicId: parsed.topicId ?? null };
  if (parsed.kind === "debug") return { kind: "debug", id: parsed.debugId };
  return null;
}

/** Resolve the resident-scoped registry key. Audience remains sessionKey. */
export function residentRegistryKey(sessionKey, { residentKey = null, taskId = null } = {}) {
  if (residentKey) return String(residentKey);
  if (taskId) return `task:${taskId}`;
  return sessionKey;
}

// Epochs deliberately survive revoke. A recycled resident receives a strictly newer
// epoch, so a request that passed token auth just before recycle still fails here.
// Maps are resident-scoped so two tasks in one conversation keep independent epochs/taints.
export function createReplyProvenanceRegistry() {
  const epochs = new Map(); // residentKey -> last minted epoch
  const active = new Map(); // residentKey -> server-owned provenance
  const taints = new Map(); // residentKey -> { epoch, reasons: Set }

  function keyOf(sessionKeyOrOpts, maybeOpts) {
    if (sessionKeyOrOpts && typeof sessionKeyOrOpts === "object") {
      const sessionKey = sessionKeyOrOpts.sessionKey;
      return residentRegistryKey(sessionKey, sessionKeyOrOpts);
    }
    return residentRegistryKey(sessionKeyOrOpts, maybeOpts ?? {});
  }

  // 批次 C taint：resident 直接看过高敏内容后，本 security epoch 持续带污点。
  // taint 按 epoch 绑定——recycle 重生拿到新 epoch，isTainted 自动归 false，无须显式清除。
  function markTainted(sessionKeyOrOpts, reason = "unspecified", opts = {}) {
    const residentKey = keyOf(sessionKeyOrOpts, typeof reason === "object" ? reason : opts);
    const reasonText = typeof reason === "string" ? reason : (reason?.reason ?? opts.reason ?? "unspecified");
    const provenance = active.get(residentKey);
    if (!provenance) return false;
    const entry = taints.get(residentKey);
    if (entry?.epoch === provenance.epoch) entry.reasons.add(String(reasonText));
    else taints.set(residentKey, { epoch: provenance.epoch, reasons: new Set([String(reasonText)]) });
    return true;
  }

  function isTainted(sessionKeyOrOpts, opts = {}) {
    const residentKey = keyOf(sessionKeyOrOpts, opts);
    const provenance = active.get(residentKey);
    const entry = taints.get(residentKey);
    return Boolean(provenance && entry && entry.epoch === provenance.epoch);
  }

  function taintReasons(sessionKeyOrOpts, opts = {}) {
    const residentKey = keyOf(sessionKeyOrOpts, opts);
    return isTainted(residentKey) ? [...taints.get(residentKey).reasons] : [];
  }

  function activate(sessionKey, opts = {}) {
    if (typeof sessionKey !== "string" || !sessionKey) throw new Error("reply egress sessionKey 必填");
    const residentKey = residentRegistryKey(sessionKey, opts);
    const epoch = (epochs.get(residentKey) ?? 0) + 1;
    epochs.set(residentKey, epoch);
    const provenance = Object.freeze({
      sessionKey, // authorized audience
      residentKey,
      taskId: opts.taskId ?? null,
      epoch,
      provenanceHash: sha256(canonicalJson({
        authority: "mstd.reply-egress.v1",
        sessionKey,
        residentKey,
        epoch,
      })),
    });
    active.set(residentKey, provenance);
    return provenance;
  }

  function resolve(sessionKeyOrOpts, opts = {}) {
    const residentKey = keyOf(sessionKeyOrOpts, opts);
    return active.get(residentKey) ?? null;
  }

  function revoke({ sessionKey, epoch, residentKey = null, taskId = null } = {}) {
    const key = residentRegistryKey(sessionKey, { residentKey, taskId });
    const current = active.get(key);
    if (!current || current.epoch !== epoch) return false;
    active.delete(key);
    return true;
  }

  return { activate, resolve, revoke, markTainted, isTainted, taintReasons, residentRegistryKey };
}

function auditBase({ provenance, deliverKey, modelHash, renderedText }) {
  const renderedHash = renderedText == null ? null : sha256(renderedText);
  return {
    epoch: provenance?.epoch ?? null,
    provenanceHash: provenance?.provenanceHash ?? null,
    audience: audienceForReplyTarget(deliverKey),
    renderedHash,
    modelHash: modelHash ?? null,
    // A model/client hash is never an authorization input. This flag is audit-only.
    modelHashMismatch: modelHash != null && modelHash !== renderedHash,
  };
}

// 席位一致性单一判定：registry 当前 provenance 必须存在，且与调用方声称的
// resident epoch（以及 post 阶段 pre 时冻结的 provenance）逐项一致。
// expected.provenance 传 undefined 表示本阶段不比对冻结值（pre 阶段）。
function staleResident(current, { provenance = undefined, residentEpoch = null } = {}) {
  if (!current) return true;
  if (provenance !== undefined && current.epoch !== provenance?.epoch) return true;
  if (residentEpoch != null && current.epoch !== residentEpoch) return true;
  return false;
}

export function checkReplyPreRender({
  registry = null,
  sessionKey,
  residentKey = null,
  taskId = null,
  residentEpoch = null,
  deliverKey,
  brief,
  kind = "message",
  internalDisclosure = null,
} = {}) {
  const provenance = registry?.resolve(sessionKey, { residentKey, taskId }) ?? null;
  if (registry && staleResident(provenance, { residentEpoch })) {
    return { ok: false, code: "stale_resident", audit: auditBase({ provenance, deliverKey }) };
  }
  if (kind !== "message" && kind !== "card_copy") {
    return { ok: false, code: "invalid_kind", audit: auditBase({ provenance, deliverKey }) };
  }
  if (!asText(brief)) return { ok: false, code: "missing_brief", audit: auditBase({ provenance, deliverKey }) };
  // card_copy never leaves the daemon; a target is only a rendering-scene hint there.
  // Legacy/test callers without the resident registry retain deliverText's historical
  // invalid-session error. Production always injects the registry and fails closed here.
  if (registry && kind === "message" && !audienceForReplyTarget(deliverKey)) {
    return { ok: false, code: "invalid_audience", audit: auditBase({ provenance, deliverKey }) };
  }
  const dlp = scanReplyDlp(brief);
  if (dlp.length) return { ok: false, code: "pre_render_dlp", dlp, audit: auditBase({ provenance, deliverKey }) };
  const disclosure = scanInternalDisclosure(internalDisclosure, brief, deliverKey);
  const audit = attachInternalDisclosureAudit(auditBase({ provenance, deliverKey }), disclosure);
  if (disclosure.blocked.length) return { ok: false, code: "internal_disclosure", disclosure: disclosure.blocked, audit };
  return { ok: true, provenance, audit };
}

export function checkReplyPostRender({
  registry = null,
  sessionKey = null,
  residentKey = null,
  taskId = null,
  residentEpoch = null,
  provenance = null,
  deliverKey,
  text,
  modelHash = null,
  allowedLinkDomains = DEFAULT_ALLOWED_LINK_DOMAINS,
  verbatimGuard = null,
  internalDisclosure = null,
} = {}) {
  const current = registry && sessionKey
    ? registry.resolve(sessionKey, { residentKey: residentKey ?? provenance?.residentKey, taskId: taskId ?? provenance?.taskId })
    : provenance;
  if (registry && staleResident(current, { provenance, residentEpoch })) {
    return { ok: false, code: "stale_resident", audit: auditBase({ provenance, deliverKey, modelHash }) };
  }
  const rendered = asText(text);
  const audit = auditBase({ provenance, deliverKey, modelHash, renderedText: rendered });
  if (!rendered) return { ok: false, code: "empty_render", audit };
  const dlp = scanReplyDlp(rendered);
  if (dlp.length) return { ok: false, code: "post_render_dlp", dlp, audit };
  const disclosure = scanInternalDisclosure(internalDisclosure, rendered, deliverKey);
  const disclosureAudit = attachInternalDisclosureAudit(audit, disclosure);
  if (disclosure.blocked.length) return { ok: false, code: "internal_disclosure", disclosure: disclosure.blocked, audit: disclosureAudit };
  const injectionSignals = scanInjectionSignals(rendered);
  if (injectionSignals.length) return { ok: false, code: "post_render_instructional_payload", injectionSignals, audit: disclosureAudit };
  const linkViolations = scanReplyLinks(rendered, allowedLinkDomains);
  if (linkViolations.length) return { ok: false, code: "post_render_link_policy", linkViolations, audit: disclosureAudit };
  const mentionViolations = scanReplyMentions(rendered);
  if (mentionViolations.length) return { ok: false, code: "post_render_mention_policy", mentionViolations, audit: disclosureAudit };
  // 逐字引用（批次 C）：群聊默认禁止逐字复制已读源；私聊受总量预算。
  if (verbatimGuard && sessionKey) {
    const verbatim = verbatimGuard.check(sessionKey, rendered, { audience: disclosureAudit.audience?.kind ?? null });
    if (!verbatim.ok) return { ok: false, code: verbatim.code, verbatim, audit: disclosureAudit };
  }
  return { ok: true, audit: disclosureAudit };
}

// 装配期绑定一次（registry/verbatimGuard/链接白名单是进程级依赖），调用点只传每次数据。
// 传空依赖得到的是"无 registry 语义"的 checker（automation 等 daemon-only 场景）。
export function createReplyEgressChecker({
  registry = null,
  verbatimGuard = null,
  allowedLinkDomains = DEFAULT_ALLOWED_LINK_DOMAINS,
  internalDisclosure = null,
} = {}) {
  return {
    preRender: (args) => checkReplyPreRender({ registry, internalDisclosure, ...args }),
    postRender: (args) => checkReplyPostRender({ registry, verbatimGuard, allowedLinkDomains, internalDisclosure, ...args }),
  };
}

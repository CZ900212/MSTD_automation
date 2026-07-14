import { createHash, timingSafeEqual } from "node:crypto";
import { types as utilTypes } from "node:util";
import { createContextBudget, countContextBytes } from "./context-budget.mjs";
import { assertTrustBoundary, TRUST } from "./trust-boundary.mjs";
import { scanInjectionSignals } from "./injection-signals.mjs";
import { stringListSnapshot } from "./safe-snapshot.mjs";

export const CONTEXT_ENVELOPE_VERSION = "mstd.context-envelope.v1";
export const CONTEXT_ENCODING = "utf8-nfc";

const ISSUED_ENVELOPES = new WeakSet();
const CANONICAL_KEYS = Object.freeze([
  "schemaVersion", "trust", "source", "scope", "sensitivity",
  "rawHash", "normalizedHash", "parentHashes", "signals", "truncated",
  "originalBytes", "byteLength", "encoding", "content",
]);

function hasUnpairedSurrogate(value) {
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i);
    if (code >= 0xD800 && code <= 0xDBFF) {
      if (i + 1 >= value.length) return true;
      const next = value.charCodeAt(i + 1);
      if (next < 0xDC00 || next > 0xDFFF) return true;
      i += 1;
    } else if (code >= 0xDC00 && code <= 0xDFFF) return true;
  }
  return false;
}

function validHash(value) {
  return typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
}

function hashText(value) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function equalHash(left, right) {
  if (!validHash(left) || !validHash(right)) return false;
  return timingSafeEqual(Buffer.from(left, "hex"), Buffer.from(right, "hex"));
}

function normalizeWithinBudget(rawContent, budget) {
  const normalized = rawContent.normalize("NFC");
  const fitted = budget.fit(normalized);
  if (!fitted.truncated) return { ...fitted, text: normalized };

  // NFC can expand one source code point into several normalized code points.
  // Truncate on whole source points only; never retain half of one source
  // point's normalization expansion. Normalized byte length is monotonic in the
  // source prefix, so binary search the longest fitting prefix — a linear
  // pop-one-point loop is O(n²) and freezes the event loop on large inputs.
  const sourcePoints = Array.from(rawContent);
  let lo = 0;
  let hi = sourcePoints.length - 1; // full length is known not to fit
  let best = null;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const candidate = sourcePoints.slice(0, mid).join("").normalize("NFC");
    const candidateFit = budget.fit(candidate);
    if (candidateFit.truncated) {
      hi = mid - 1;
    } else {
      best = { ...candidateFit, text: candidate, truncated: true };
      lo = mid + 1;
    }
  }
  return best ?? { ...budget.fit(""), text: "", truncated: true };
}

function immutableStrings(value, label) {
  return Object.freeze([...new Set(stringListSnapshot(value, label))].sort());
}

function snapshotEnvelope(value) {
  if (!value || typeof value !== "object" || Array.isArray(value) || utilTypes.isProxy(value)) {
    throw new Error("context envelope 必须是 plain object");
  }
  const expectedKeys = [...CANONICAL_KEYS, "signature"];
  const signatureDescriptor = Object.getOwnPropertyDescriptor(value, "signature");
  // Inspect descriptors before reading any property. A rejected accessor must never
  // execute attacker-controlled code during validation or telemetry.
  for (const key of expectedKeys) {
    const descriptor = key === "signature" ? signatureDescriptor : Object.getOwnPropertyDescriptor(value, key);
    if (key === "signature" && !descriptor) continue;
    if (!descriptor || "get" in descriptor || "set" in descriptor) throw new Error("context envelope accessor 非法");
  }
  const snapshot = {
    schemaVersion: value.schemaVersion,
    trust: value.trust,
    source: value.source,
    scope: value.scope,
    sensitivity: value.sensitivity,
    rawHash: value.rawHash,
    normalizedHash: value.normalizedHash,
    parentHashes: value.parentHashes,
    signals: value.signals,
    truncated: value.truncated,
    originalBytes: value.originalBytes,
    byteLength: value.byteLength,
    encoding: value.encoding,
    content: value.content,
    signature: signatureDescriptor?.value ?? null,
  };
  return snapshot;
}

function freezeEnvelope(value, { issued = false } = {}) {
  const envelope = Object.freeze({
    ...value,
    parentHashes: immutableStrings(value.parentHashes, "context parent hashes"),
    signals: immutableStrings(value.signals, "context signals"),
  });
  if (issued) ISSUED_ENVELOPES.add(envelope);
  return envelope;
}

export function canonicalEnvelopePayload(value) {
  const snapshot = snapshotEnvelope(value);
  const canonical = {};
  for (const key of CANONICAL_KEYS) {
    if (key === "parentHashes" || key === "signals") {
      canonical[key] = immutableStrings(snapshot[key], `context ${key}`);
    } else {
      canonical[key] = snapshot[key];
    }
  }
  return JSON.stringify(canonical);
}

function envelopeSignature(value, signer) {
  if (typeof signer !== "function") return null;
  const signature = signer(canonicalEnvelopePayload(value));
  if (!validHash(signature)) throw new Error("context envelope signature 非法");
  return signature;
}

function equalStringLists(left, right, label = "context strings") {
  const leftSnapshot = stringListSnapshot(left, label);
  return leftSnapshot.length === right.length
    && leftSnapshot.every((item, index) => item === right[index]);
}

function safeTelemetryString(value, key) {
  if (!value || typeof value !== "object" || utilTypes.isProxy(value)) return null;
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  if (!descriptor || "get" in descriptor || "set" in descriptor) return null;
  return typeof descriptor.value === "string" ? descriptor.value : null;
}

function failure(message, envelope, onSecurityEvent) {
  try {
    onSecurityEvent?.({
      type: "envelope_tampered",
      schemaVersion: safeTelemetryString(envelope, "schemaVersion"),
      rawHash: safeTelemetryString(envelope, "rawHash"),
      normalizedHash: safeTelemetryString(envelope, "normalizedHash"),
      source: safeTelemetryString(envelope, "source"),
      scope: safeTelemetryString(envelope, "scope"),
    });
  } catch { /* telemetry must not bypass fail-closed behavior */ }
  const error = new Error(message);
  error.code = "ENVELOPE_TAMPERED";
  throw error;
}

// Sole content constructor. This security-relevant sequence is fixed:
// byte limit -> raw hash -> raw scan -> NFC -> normalized scan -> normalized hash.
export function createContextEnvelope(input = {}, { budget = createContextBudget(), signer = null } = {}) {
  if (!budget || typeof budget.fit !== "function") throw new Error("context budget 缺失");
  const inputContent = String(input.content ?? "");
  if (hasUnpairedSurrogate(inputContent)) throw new Error("context content 含非法 Unicode surrogate");
  const rawFitted = budget.fit(inputContent);
  const rawContent = rawFitted.text;
  const rawHash = hashText(rawContent);
  // Scan raw bytes before normalization even though only final-body signals are retained.
  scanInjectionSignals(rawContent);
  const normalized = rawContent.normalize("NFC");
  if (hasUnpairedSurrogate(normalized)) throw new Error("context content 含非法 Unicode surrogate");
  // NFC can expand one source point. Re-budget by source-point boundaries so
  // truncation cannot keep only a fragment of that expansion.
  const normalizedFitted = normalizeWithinBudget(rawContent, budget);
  const content = normalizedFitted.text;
  const normalizedSignals = scanInjectionSignals(content);
  const boundary = assertTrustBoundary({
    trust: input.trust ?? TRUST.UNTRUSTED,
    source: input.source ?? "user",
    scope: input.scope ?? input.sessionKey,
    sensitivity: input.sensitivity ?? "internal",
  });

  const unsigned = {
    schemaVersion: CONTEXT_ENVELOPE_VERSION,
    ...boundary,
    rawHash,
    normalizedHash: hashText(content),
    parentHashes: input.parentHashes ?? [],
    // Retain only signals still present in the consumed body. Raw-only signals
    // are useful before clipping, but cannot describe the final envelope body.
    signals: normalizedSignals,
    truncated: Boolean(rawFitted.truncated || normalizedFitted.truncated),
    originalBytes: rawFitted.originalBytes,
    byteLength: countContextBytes(content),
    encoding: CONTEXT_ENCODING,
    content,
  };
  return freezeEnvelope({
    ...unsigned,
    signature: envelopeSignature(unsigned, signer),
  }, { issued: true });
}

// Consumers call this immediately before use. Constructor-produced frozen
// envelopes preserve identity; deserialized/plain inputs return a frozen copy.
export function assertEnvelope(envelope, {
  scope = null,
  allowedSources = null,
  allowedSensitivities = null,
  verifier = null,
  requireSignature = false,
  onSecurityEvent = null,
} = {}) {
  let snapshot;
  try {
    snapshot = snapshotEnvelope(envelope);
    if (snapshot.schemaVersion !== CONTEXT_ENVELOPE_VERSION) throw new Error("context envelope version 不兼容");
    assertTrustBoundary(snapshot);
    if (typeof snapshot.content !== "string" || hasUnpairedSurrogate(snapshot.content)) throw new Error("context envelope content 非法");
    if (snapshot.content !== snapshot.content.normalize("NFC")) throw new Error("context envelope Unicode 规范化漂移");
    if (snapshot.encoding !== CONTEXT_ENCODING) throw new Error("context envelope encoding 不兼容");
    if (typeof snapshot.truncated !== "boolean" || !Number.isSafeInteger(snapshot.originalBytes) || snapshot.originalBytes < 0) throw new Error("context envelope budget 元数据非法");
    if (!Number.isSafeInteger(snapshot.byteLength) || snapshot.byteLength < 0 || snapshot.byteLength !== countContextBytes(snapshot.content)) throw new Error("context envelope byteLength 不匹配");
    if (!validHash(snapshot.rawHash)) throw new Error("context envelope raw hash 非法");
    const parentHashes = immutableStrings(snapshot.parentHashes, "context parent hashes");
    if (parentHashes.some((hash) => !validHash(hash))) throw new Error("context parent hashes 非法");
    if (!equalStringLists(snapshot.parentHashes, parentHashes, "context parent hashes")) throw new Error("context parent hashes 非 canonical");
    const signals = immutableStrings(snapshot.signals, "context signals");
    if (!equalStringLists(snapshot.signals, signals, "context signals")) throw new Error("context envelope signals 非 canonical");
    const expectedSignals = immutableStrings(scanInjectionSignals(snapshot.content), "context signals");
    if (!equalStringLists(signals, expectedSignals)) throw new Error("context envelope signals 已篡改");
    if (!equalHash(snapshot.normalizedHash, hashText(snapshot.content))) throw new Error("context envelope normalized hash 不匹配");
    if (scope !== null && snapshot.scope !== scope) throw new Error("context envelope scope 不匹配");
    if (allowedSources && !allowedSources.includes(snapshot.source)) throw new Error("context envelope 来源不允许");
    if (allowedSensitivities && !allowedSensitivities.includes(snapshot.sensitivity)) throw new Error("context envelope 敏感级别不允许");
    if (verifier || requireSignature) {
      if (typeof verifier !== "function" || !validHash(snapshot.signature)) throw new Error("context envelope signature 缺失");
      if (!equalHash(snapshot.signature, envelopeSignature(snapshot, verifier))) throw new Error("context envelope signature 不匹配");
    }
    if (ISSUED_ENVELOPES.has(envelope)) return envelope;
    return freezeEnvelope(snapshot);
  } catch (error) {
    failure(error.message, snapshot ?? envelope, onSecurityEvent);
  }
}

export function resolveTurnContext({
  content,
  envelope = null,
  mode = "enforce",
  scope,
  source = "user",
  sensitivity = "internal",
  signer = null,
  budget = createContextBudget(),
  onEvent = null,
} = {}) {
  if (mode !== "enforce" && mode !== "shadow") {
    throw new Error(`context mode 非法: ${mode}`);
  }
  const emit = (event) => {
    try { onEvent?.(event); } catch { /* telemetry must not affect context consumption */ }
  };
  const onSecurityEvent = (event) => emit({
    ...event,
    sessionKey: event.scope ?? null,
  });
  const legacyContent = content === null || content === undefined
    ? content
    : String(content);
  const hasLegacyContent = legacyContent !== null && legacyContent !== undefined;
  const malformed = envelope !== null && envelope !== undefined
    && (typeof envelope !== "object" || Array.isArray(envelope));
  if (malformed && mode === "enforce") {
    throw new Error("context envelope 缺失或类型非法");
  }
  if (malformed) {
    emit({
      type: "context_envelope_rejected",
      mode,
      sessionKey: scope,
      reason: "context envelope 缺失或类型非法",
    });
  }

  let candidate = malformed ? null : envelope;
  if (candidate === null && hasLegacyContent) {
    try {
      candidate = createContextEnvelope({
        trust: TRUST.UNTRUSTED,
        source,
        sensitivity,
        scope,
        content: legacyContent,
      }, { budget, signer });
    } catch (error) {
      emit({
        type: "context_envelope_rejected",
        mode,
        sessionKey: scope,
        reason: String(error.message ?? error),
      });
      if (mode === "enforce") throw error;
    }
  }

  let checked = candidate;
  if (candidate) {
    try {
      checked = assertEnvelope(candidate, {
        scope,
        ...(signer ? { verifier: signer, requireSignature: true } : {}),
        onSecurityEvent,
      });
    } catch (error) {
      emit({
        type: "context_envelope_rejected",
        mode,
        sessionKey: scope,
        reason: String(error.message ?? error),
      });
      if (mode === "enforce") throw error;
      checked = null;
    }
    if (checked) {
      emit({
        type: "context_envelope",
        mode,
        sessionKey: scope,
        source: checked.source,
        sensitivity: checked.sensitivity,
        signals: checked.signals,
        truncated: checked.truncated,
        rawHash: checked.rawHash,
        normalizedHash: checked.normalizedHash,
        shadow: mode === "shadow" ? {
          legacyChars: Array.from(legacyContent ?? "").length,
          envelopeBytes: checked.byteLength,
          sameBody: legacyContent == null
            ? null
            : !checked.truncated && checked.content === legacyContent,
        } : null,
      });
    }
  }

  const promptContext = mode === "shadow" && hasLegacyContent
    ? legacyContent
    : checked?.content ?? (mode === "shadow" ? legacyContent : null);
  return Object.freeze({ promptContext, envelope: checked });
}

export function serializeEnvelope(envelope, options = {}) {
  return JSON.stringify(assertEnvelope(envelope, options));
}

export function deserializeEnvelope(serialized, options = {}) {
  let parsed;
  try {
    parsed = typeof serialized === "string" ? JSON.parse(serialized) : serialized;
  } catch {
    failure("context envelope serialization 非法", null, options.onSecurityEvent);
  }
  return assertEnvelope(parsed, options);
}

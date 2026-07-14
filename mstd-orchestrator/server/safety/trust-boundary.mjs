const TRUST_LEVELS = new Set(["untrusted", "internal", "trusted"]);
const SENSITIVITIES = new Set(["public", "internal", "sensitive", "restricted"]);
const SOURCES = new Set(["user", "history", "memory", "tool", "background", "system"]);

function nonEmptyString(value, label) {
  if (typeof value !== "string" || !value) throw new Error(`${label} 缺失`);
  return value;
}

// The boundary is deliberately metadata-only. Content integrity belongs to the
// context envelope, where a consumer can recompute the normalized text hash.
export function assertTrustBoundary({ trust, source, scope, sensitivity } = {}) {
  if (!TRUST_LEVELS.has(trust)) throw new Error("context trust 不受信任或未知");
  if (!SOURCES.has(source)) throw new Error("context source 不受信任或未知");
  if (!SENSITIVITIES.has(sensitivity)) throw new Error("context sensitivity 不受信任或未知");
  return Object.freeze({
    trust,
    source,
    scope: nonEmptyString(scope, "context scope"),
    sensitivity,
  });
}

export const TRUST = Object.freeze({
  UNTRUSTED: "untrusted",
  INTERNAL: "internal",
  TRUSTED: "trusted",
});

export { SENSITIVITIES, SOURCES, TRUST_LEVELS };

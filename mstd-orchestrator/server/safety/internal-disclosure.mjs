export const DEFAULT_INTERNAL_TOOL_AUDIT_PATTERNS = Object.freeze([
  "spawn_background_job",
  "lark_read",
  "session_search",
  "heartbeat_update",
  "propose_actions",
  "read_file",
]);

function identifierPattern(value) {
  const escaped = value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(?<![A-Za-z0-9_])${escaped}(?![A-Za-z0-9_])`);
}

export function createInternalDisclosureScanner({
  knownStrings = [],
  auditPatterns = DEFAULT_INTERNAL_TOOL_AUDIT_PATTERNS,
} = {}) {
  const known = [...new Set(knownStrings.filter((value) => typeof value === "string" && value.length > 0))];
  const audits = [...new Set(auditPatterns.filter((value) => typeof value === "string" && value.length > 0))]
    .map((name) => ({ name, pattern: identifierPattern(name) }));

  return {
    scan(value) {
      const text = String(value ?? "");
      return {
        // Never return the configured values: audit records must not become a second leak.
        blocked: known.flatMap((needle, index) => text.includes(needle) ? [`known_string_${index}`] : []),
        audit: audits.flatMap(({ name, pattern }) => pattern.test(text) ? [name] : []),
      };
    },
  };
}

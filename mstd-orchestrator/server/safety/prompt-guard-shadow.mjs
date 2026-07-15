// Optional Prompt Guard adapter. It is telemetry-only: its output never blocks a request.
// No model or dependency is installed/downloaded here. A missing optional classifier is reported as skipped.

export function createPromptGuardShadow({ classifier = null, emit = () => {} } = {}) {
  async function inspect({ text, locale = "", source = "" } = {}) {
    const startedAt = performance.now();
    if (typeof classifier !== "function") {
      const result = {
        mode: "shadow",
        status: "skipped",
        reason: "optional_classifier_unavailable",
        flagged: null,
        latencyMs: performance.now() - startedAt,
      };
      emit({ type: "prompt_guard_shadow", locale, source, ...result });
      return result;
    }

    try {
      const raw = await classifier({ text: String(text ?? ""), locale, source });
      const result = {
        mode: "shadow",
        status: "ran",
        flagged: Boolean(raw?.flagged),
        label: raw?.label ?? null,
        latencyMs: performance.now() - startedAt,
      };
      emit({ type: "prompt_guard_shadow", locale, source, ...result });
      return result;
    } catch (error) {
      const result = {
        mode: "shadow",
        status: "skipped",
        reason: "optional_classifier_error",
        flagged: null,
        latencyMs: performance.now() - startedAt,
      };
      emit({ type: "prompt_guard_shadow", locale, source, ...result });
      return result;
    }
  }

  return { inspect };
}

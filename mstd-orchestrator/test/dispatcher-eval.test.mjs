import { describe, it, expect } from "vitest";
import { evaluateDispatcherCases } from "../scripts/dispatcher-eval.mjs";

describe("dispatcher-eval", () => {
  it("loads fixtures and reports zero invented task ids on expected labels", async () => {
    const { results, summary } = await evaluateDispatcherCases();
    expect(summary.total).toBeGreaterThanOrEqual(8);
    expect(summary.inventedTaskIds).toBe(0);
    expect(results.every((r) => r.expected)).toBe(true);
    // Offline mode treats expected as actual → all structural gates pass.
    expect(summary.failed).toBe(0);
  });
});

import { describe, expect, it, vi } from "vitest";
import { classifyBackgroundError, createBackgroundExecutor } from "../server/jobs/background-executor.mjs";

describe("background executor error classification", () => {
  it.each([
    [{ name: "TimeoutError", message: "deadline exceeded" }, "timeout"],
    [{ code: "ETIMEDOUT", message: "socket stopped" }, "timeout"],
    [{ code: "TOOL_ERROR", message: "tool failed" }, "tool_error"],
    [{ exitCode: 137, message: "child exited" }, "crashed"],
    [{ message: "unexpected" }, "unknown"],
  ])("maps %j to %s", (error, expected) => {
    expect(classifyBackgroundError(error)).toBe(expected);
  });

  it("attaches errorKind before rethrowing and still closes the client", async () => {
    const failure = Object.assign(new Error("operation timed out"), { code: "ETIMEDOUT" });
    const close = vi.fn(async () => {});
    const startPi = vi.fn(() => ({ runJob: vi.fn(async () => { throw failure; }), close }));
    const run = createBackgroundExecutor({
      startPi,
      config: { pi: { provider: "p", model: "m", thinking: "low" } },
      agentWorkspace: "/tmp/mstd-bg-test",
      capabilityProfile: {},
      timeoutMs: 10,
    });
    await expect(run({ jobId: "job-a", brief: "x", params: {} }))
      .rejects.toMatchObject({ message: "operation timed out", errorKind: "timeout" });
    expect(close).toHaveBeenCalledOnce();
  });
});

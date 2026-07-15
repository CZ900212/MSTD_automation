import { describe, it, expect } from "vitest";
import { assertLiveEnv, evaluateDispatcherCases } from "../scripts/dispatcher-eval.mjs";

describe("dispatcher-eval", () => {
  it("offline validates synthetic fixtures without copying expected into actual", async () => {
    const { results, summary } = await evaluateDispatcherCases();
    expect(summary.total).toBeGreaterThanOrEqual(8);
    expect(summary.structural_only).toBe(true);
    expect(summary.inventedTaskIds).toBe(0);
    expect(results.every((r) => r.expected)).toBe(true);
    expect(results.every((r) => r.actual === null)).toBe(true);
    expect(summary.failed).toBe(0);
  });

  it("offline makes no caller requests and rejects non-synthetic fixtures", async () => {
    let calls = 0;
    const fixtures = [{
      id: "unsafe",
      label: "unsafe",
      synthetic: false,
      mode: "p2p",
      userText: "real text",
      expected: { action: "no_reasoning" },
    }];
    const out = await evaluateDispatcherCases({ fixtures, caller: { call: async () => { calls += 1; } } });
    expect(calls).toBe(0);
    expect(out.summary.failed).toBe(1);
    expect(out.results[0].errors).toContain("fixture_not_synthetic");
  });

  it("live runs Responder then Dispatcher and reports only sanitized outcome metadata", async () => {
    const caller = {
      call: async (chain) => chain === "responder"
        ? { text: '{"action":"reply","text":"我去查"}', model: "responder-model", usage: null }
        : {
          text: '{"action":"spawn_new","title":"查会议室","brief":"查空档","closure":"required","reason_code":"needs_tools"}',
          model: "dispatcher-model",
          usage: null,
        },
    };
    const fixtures = [{
      id: "live-one",
      label: "tool_required",
      synthetic: true,
      mode: "p2p",
      userText: "synthetic request",
      activeTaskCandidates: [],
      expected: { action: "spawn_new", closure: "required" },
    }];
    const out = await evaluateDispatcherCases({ fixtures, caller, mode: "live" });
    expect(out.summary).toMatchObject({ structural_only: false, failed: 0 });
    expect(out.results[0].actual).toMatchObject({
      action: "spawn_new",
      closure: "required",
      responder_source: "live",
      provider: "dispatcher-model",
      fallback: false,
      latencyMs: expect.any(Number),
    });
    expect(JSON.stringify(out)).not.toContain("synthetic request");
    expect(JSON.stringify(out)).not.toContain("我去查");
  });

  it("live reviews the fixture's actual sent reply without regenerating it", async () => {
    const calls = [];
    const caller = {
      call: async (chain) => {
        calls.push(chain);
        if (chain === "responder") throw new Error("fixture reply must not be regenerated");
        return {
          text: '{"action":"spawn_new","title":"查会议室","brief":"查空档","closure":"required","reason_code":"needs_tools"}',
          model: "dispatcher-model",
          usage: null,
        };
      },
    };
    const fixtures = [{
      id: "fixture-reply",
      label: "promise_to_check",
      synthetic: true,
      mode: "p2p",
      userText: "synthetic request",
      responderText: "synthetic sent reply",
      activeTaskCandidates: [],
      expected: { action: "spawn_new", closure: "required" },
    }];

    const out = await evaluateDispatcherCases({ fixtures, caller, mode: "live" });

    expect(calls).toEqual(["dispatcher"]);
    expect(out.summary).toMatchObject({ fixture_responder_cases: 1, live_responder_cases: 0, failed: 0 });
    expect(out.results[0].actual).toMatchObject({ responder_source: "fixture" });
    expect(JSON.stringify(out)).not.toContain("synthetic sent reply");
  });

  it("live fails closed on provider or invalid-output fallback", async () => {
    const fixtures = [{
      id: "live-fail",
      label: "provider_failure",
      synthetic: true,
      mode: "p2p",
      userText: "synthetic request",
      activeTaskCandidates: [],
      expected: { action: "spawn_new" },
    }];
    const caller = { call: async (chain) => {
      if (chain === "responder") return { text: '{"action":"reply","text":"处理中"}', model: "r", usage: null };
      throw new Error("provider unavailable");
    } };
    const out = await evaluateDispatcherCases({ fixtures, caller, mode: "live" });
    expect(out.summary.failed).toBe(1);
    expect(out.results[0].errors).toContain("dispatcher_fallback");
  });

  it("injects an explicitly declared dispatcher fault and audits the expected fallback", async () => {
    let calls = 0;
    const fixtures = [{
      id: "live-injected-fail",
      label: "provider_failure",
      synthetic: true,
      mode: "addressed",
      userText: "synthetic request",
      responderText: "synthetic sent reply",
      dispatcherFault: "provider_error",
      activeTaskCandidates: [],
      expected: { action: "spawn_new", closure: "silent_ok" },
    }];
    const caller = { call: async () => {
      calls += 1;
      throw new Error("the injected fault must replace the provider call");
    } };

    const out = await evaluateDispatcherCases({ fixtures, caller, mode: "live" });

    expect(calls).toBe(0);
    expect(out.summary).toMatchObject({ synthetic_faults: 1, failed: 0 });
    expect(out.results[0].actual).toMatchObject({ fallback: true, fault_injected: true });
    expect(out.results[0].errors).not.toContain("dispatcher_fallback");
  });

  it("live rejects missing provider credentials before any request", () => {
    expect(() => assertLiveEnv({})).toThrow(/provider key/i);
    expect(() => assertLiveEnv({ DEEPSEEK_KEY: "synthetic-key" })).not.toThrow();
  });
});

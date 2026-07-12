import { describe, it, expect, vi } from "vitest";
import { createModelCaller, PipelineError, CHAINS } from "../server/models/caller.mjs";

const ENV = { DEEPSEEK_KEY: "dk", CZ_GPT_KEY: "gk", CZ_CLAUDE_KEY: "ck" };

const okResponse = (text, model) => ({
  ok: true,
  json: async () => ({ choices: [{ message: { content: text } }], model, usage: { prompt_tokens: 10, completion_tokens: 5 } }),
});
const errResponse = { ok: false, status: 500, text: async () => "boom" };

describe("model caller", () => {
  it("首模型失败 5 次（sleep 5×10s）后降级第二模型，返回其结果与 model 标识", async () => {
    const calls = [];
    let n = 0;
    const fetchFn = vi.fn(async (url, opts) => {
      calls.push({ url, body: JSON.parse(opts.body) });
      n += 1;
      if (n <= 5) return errResponse;              // v4-flash 5 次全挂
      return okResponse("来自 Opus", "claude-opus-4-6");
    });
    const sleepFn = vi.fn(async () => {});
    const caller = createModelCaller({ fetchFn, env: ENV, sleepFn, retries: 5, retryDelayMs: 10_000 });
    const out = await caller.call("fast", { system: "s", messages: [{ role: "user", content: "hi" }] });
    expect(out.text).toBe("来自 Opus");
    expect(out.model).toBe("opus-4.6");
    expect(sleepFn).toHaveBeenCalledTimes(5);
    expect(sleepFn).toHaveBeenCalledWith(10_000);
    // 前 5 次打 v4-flash，第 6 次打 opus
    expect(calls[0].body.model).toBe("deepseek-v4-flash");
    expect(calls[0].body.reasoning_effort).toBeUndefined();
    expect(calls[0].body.thinking).toEqual({ type: "disabled" });
    expect(calls[5].body.model).toBe("claude-opus-4-6");
  });

  it("三个模型全挂（各 5 次）抛 PipelineError", async () => {
    const fetchFn = vi.fn(async () => errResponse);
    const sleepFn = vi.fn(async () => {});
    const caller = createModelCaller({ fetchFn, env: ENV, sleepFn, retries: 5 });
    await expect(caller.call("reason", { messages: [{ role: "user", content: "x" }] }))
      .rejects.toThrow(PipelineError);
    expect(fetchFn).toHaveBeenCalledTimes(15);
    expect(sleepFn).toHaveBeenCalledTimes(15);
  });

  it("fast 链显式关闭 thinking；reason 链 gpt-5.6-sol 带 medium effort", async () => {
    const bodies = [];
    const fetchFn = vi.fn(async (_url, opts) => { bodies.push(JSON.parse(opts.body)); return okResponse("ok", "m"); });
    const caller = createModelCaller({ fetchFn, env: ENV, sleepFn: async () => {} });
    await caller.call("fast", { messages: [{ role: "user", content: "x" }] });
    expect(bodies[0].reasoning_effort).toBeUndefined();
    await caller.call("reason", { messages: [{ role: "user", content: "x" }] });
    expect(bodies[1].model).toBe("gpt-5.6-sol");
    expect(bodies[1].reasoning_effort).toBe("medium");
  });

  it("system 注入为首条 system message；网关鉴权头正确", async () => {
    let captured;
    const fetchFn = vi.fn(async (url, opts) => { captured = { url, headers: opts.headers, body: JSON.parse(opts.body) }; return okResponse("ok", "m"); });
    const caller = createModelCaller({ fetchFn, env: ENV, sleepFn: async () => {} });
    await caller.call("respond", { system: "你是出口", messages: [{ role: "user", content: "x" }] });
    expect(captured.body.messages[0]).toEqual({ role: "system", content: "你是出口" });
    expect(captured.body.model).toBe("deepseek-v4-pro");
    expect(captured.body.reasoning_effort).toBeUndefined();
    expect(captured.body.thinking).toEqual({ type: "disabled" });
    expect(captured.url).toContain("api.deepseek.com");           // respond 首选 v4-pro non-thinking
    expect(captured.headers.Authorization).toBe("Bearer dk");
  });

  it("respond 的 DeepSeek 连败后降级 GPT-5.6 Sol medium", async () => {
    const calls = [];
    let n = 0;
    const fetchFn = vi.fn(async (url, opts) => {
      calls.push({ url, body: JSON.parse(opts.body) });
      n += 1;
      return n <= 5 ? errResponse : okResponse("兜底回复", "gpt-5.6-sol");
    });
    const caller = createModelCaller({ fetchFn, env: ENV, sleepFn: async () => {} });
    const out = await caller.call("respond", { messages: [{ role: "user", content: "x" }] });
    expect(out.model).toBe("gpt-5.6-sol");
    expect(calls[0].url).toContain("api.deepseek.com");
    expect(calls[5].url).toContain("api.cz900212.com");
    expect(calls[5].body).toMatchObject({ model: "gpt-5.6-sol", reasoning_effort: "medium" });
  });

  it("onEvent 结构化上报：每次失败尝试 model_retry，降级 model_fallback", async () => {
    let n = 0;
    const fetchFn = vi.fn(async () => {
      n += 1;
      if (n <= 5) return errResponse;
      return okResponse("ok", "m");
    });
    const events = [];
    const caller = createModelCaller({ fetchFn, env: ENV, sleepFn: async () => {}, log: () => {}, onEvent: (e) => events.push(e) });
    await caller.call("fast", { messages: [{ role: "user", content: "x" }] });
    const retries = events.filter((e) => e.type === "model_retry");
    expect(retries).toHaveLength(5);
    expect(retries[0]).toMatchObject({ chain: "fast", model: "v4-flash", attempt: 1 });
    expect(retries[0].error).toContain("500");
    const fallbacks = events.filter((e) => e.type === "model_fallback");
    expect(fallbacks).toEqual([expect.objectContaining({ chain: "fast", from: "v4-flash", to: "opus-4.6" })]);
  });

  it("onEvent 全链耗尽上报 pipeline_error；onEvent 抛错不影响主流程", async () => {
    const fetchFn = vi.fn(async () => errResponse);
    const events = [];
    const caller = createModelCaller({
      fetchFn, env: ENV, sleepFn: async () => {}, retries: 1, log: () => {},
      onEvent: (e) => { events.push(e); throw new Error("observer boom"); },
    });
    await expect(caller.call("fast", { messages: [{ role: "user", content: "x" }] })).rejects.toThrow(PipelineError);
    expect(events.filter((e) => e.type === "pipeline_error")).toEqual([expect.objectContaining({ chain: "fast" })]);
  });

  it("三条链定义与用户定案一致：GPT-5.6 Sol medium 中枢，DeepSeek 出口首选", () => {
    expect(CHAINS.fast).toEqual(["v4-flash", "opus-4.6", "gpt-5.5"]);
    expect(CHAINS.reason).toEqual(["gpt-5.6-sol", "opus-4.8", "v4-pro"]);
    expect(CHAINS.respond).toEqual(["v4-pro", "gpt-5.6-sol"]);
  });
});

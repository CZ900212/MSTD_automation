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
    expect(calls[0].body.model).toBe("deepseek-chat");
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

  it("fast 链请求体不带 reasoning（强制 non-thinking）；reason 链 gpt-5.5 带 medium effort", async () => {
    const bodies = [];
    const fetchFn = vi.fn(async (url, opts) => { bodies.push(JSON.parse(opts.body)); return okResponse("ok", "m"); });
    const caller = createModelCaller({ fetchFn, env: ENV, sleepFn: async () => {} });
    await caller.call("fast", { messages: [{ role: "user", content: "x" }] });
    expect(bodies[0].reasoning_effort).toBeUndefined();
    await caller.call("reason", { messages: [{ role: "user", content: "x" }] });
    expect(bodies[1].model).toBe("gpt-5.5");
    expect(bodies[1].reasoning_effort).toBe("medium");
  });

  it("system 注入为首条 system message；网关鉴权头正确", async () => {
    let captured;
    const fetchFn = vi.fn(async (url, opts) => { captured = { url, headers: opts.headers, body: JSON.parse(opts.body) }; return okResponse("ok", "m"); });
    const caller = createModelCaller({ fetchFn, env: ENV, sleepFn: async () => {} });
    await caller.call("respond", { system: "你是出口", messages: [{ role: "user", content: "x" }] });
    expect(captured.body.messages[0]).toEqual({ role: "system", content: "你是出口" });
    expect(captured.url).toContain("api.cz900212.com");           // respond 首选 opus-4.6
    expect(captured.headers.Authorization).toBe("Bearer ck");
  });

  it("三条链定义与用户定案一致", () => {
    expect(CHAINS.fast).toEqual(["v4-flash", "opus-4.6", "gpt-5.5"]);
    expect(CHAINS.reason).toEqual(["gpt-5.5", "opus-4.8", "v4-pro"]);
    expect(CHAINS.respond).toEqual(["opus-4.6", "v4-pro", "gpt-5.5"]);
  });
});

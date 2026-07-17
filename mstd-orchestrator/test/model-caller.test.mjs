import { describe, it, expect, vi } from "vitest";
import { createModelCaller, PipelineError, CHAINS } from "../server/models/caller.mjs";
import { countModelInputTokens } from "../server/models/token-window.mjs";

const ENV = { DEEPSEEK_KEY: "dk", CZ_GPT_KEY: "gk" };

const okResponse = (text, model) => ({
  ok: true,
  json: async () => ({ choices: [{ message: { content: text } }], model, usage: { prompt_tokens: 10, completion_tokens: 5 } }),
});
const errResponse = { ok: false, status: 500, text: async () => "boom" };

describe("model caller", () => {
  it("首模型失败 5 次（默认 fastRetryDelayMs=100）后降级第二模型，返回其结果与 model 标识", async () => {
    const calls = [];
    let n = 0;
    const fetchFn = vi.fn(async (url, opts) => {
      calls.push({ url, body: JSON.parse(opts.body) });
      n += 1;
      if (n <= 5) return errResponse;              // v4-flash 5 次全挂
      return okResponse("来自 GPT", "gpt-5.5");
    });
    const sleepFn = vi.fn(async () => {});
    const caller = createModelCaller({ fetchFn, env: ENV, sleepFn, retries: 5 });
    const out = await caller.call("fast", { system: "s", messages: [{ role: "user", content: "hi" }] });
    expect(out.text).toBe("来自 GPT");
    expect(out.model).toBe("gpt-5.5");
    expect(sleepFn).toHaveBeenCalledTimes(4);
    expect(sleepFn).toHaveBeenCalledWith(100);     // 快机重试不再干等 10s（用户定案 2026-07-12）
    // 前 5 次打 v4-flash，第 6 次打 gpt-5.5
    expect(calls[0].body.model).toBe("deepseek-v4-flash");
    expect(calls[0].body.reasoning_effort).toBeUndefined();
    expect(calls[0].body.thinking).toEqual({ type: "disabled" });
    expect(calls[5].body.model).toBe("gpt-5.5");
  });

  it("pending fetch 达到 per-attempt deadline 后 abort，并继续 retry/fallback", async () => {
    const signals = [];
    let calls = 0;
    const fetchFn = vi.fn((_url, opts) => {
      calls += 1;
      signals.push(opts.signal);
      if (calls === 1) {
        return new Promise((_resolve, reject) => {
          opts.signal.addEventListener("abort", () => reject(opts.signal.reason), { once: true });
        });
      }
      return Promise.resolve(okResponse("fallback after timeout", "gpt-5.5"));
    });
    const events = [];
    const caller = createModelCaller({
      fetchFn,
      env: ENV,
      retries: 1,
      attemptTimeoutMs: 5,
      sleepFn: async () => {},
      log: () => {},
      onEvent: (event) => events.push(event),
    });

    await expect(caller.call("fast", { messages: [{ role: "user", content: "x" }] }))
      .resolves.toMatchObject({ text: "fallback after timeout", model: "gpt-5.5" });
    expect(signals[0]).toBeInstanceOf(AbortSignal);
    expect(signals[0].aborted).toBe(true);
    expect(events).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "model_retry", model: "v4-flash", attempt: 1 }),
      expect.objectContaining({ type: "model_fallback", from: "v4-flash", to: "gpt-5.5" }),
    ]));
  });

  it("response body parsing is covered by the same per-attempt deadline", async () => {
    let calls = 0;
    const fetchFn = vi.fn(async (_url, opts) => {
      calls += 1;
      if (calls === 1) {
        return {
          ok: true,
          json: () => new Promise((_resolve, reject) => {
            opts.signal.addEventListener("abort", () => reject(opts.signal.reason), { once: true });
          }),
        };
      }
      return okResponse("fallback after body timeout", "gpt-5.5");
    });
    const caller = createModelCaller({
      fetchFn,
      env: ENV,
      retries: 1,
      attemptTimeoutMs: 5,
      sleepFn: async () => {},
      log: () => {},
    });

    await expect(caller.call("fast", { messages: [{ role: "user", content: "x" }] }))
      .resolves.toMatchObject({ text: "fallback after body timeout", model: "gpt-5.5" });
  });

  it("全链模型全挂（各 5 次）抛 PipelineError", async () => {
    const fetchFn = vi.fn(async () => errResponse);
    const sleepFn = vi.fn(async () => {});
    const caller = createModelCaller({ fetchFn, env: ENV, sleepFn, retries: 5 });
    await expect(caller.call("reason", { messages: [{ role: "user", content: "x" }] }))
      .rejects.toThrow(PipelineError);
    expect(fetchFn).toHaveBeenCalledTimes(10);
    expect(sleepFn).toHaveBeenCalledTimes(8);
    expect(sleepFn).toHaveBeenCalledWith(10_000);
  });

  it("respond 链默认保留 10s 重试间隔，数字覆盖仍兼容所有链", async () => {
    const fetchFn = vi.fn(async () => errResponse);
    const conservativeSleep = vi.fn(async () => {});
    const caller = createModelCaller({ fetchFn, env: ENV, sleepFn: conservativeSleep, retries: 2 });
    await expect(caller.call("respond", { messages: [{ role: "user", content: "x" }] })).rejects.toThrow(PipelineError);
    expect(conservativeSleep).toHaveBeenCalledTimes(2);
    expect(conservativeSleep).toHaveBeenCalledWith(10_000);

    const overrideSleep = vi.fn(async () => {});
    const overridden = createModelCaller({ fetchFn, env: ENV, sleepFn: overrideSleep, retries: 2, retryDelayMs: 7 });
    await expect(overridden.call("respond", { messages: [{ role: "user", content: "x" }] })).rejects.toThrow(PipelineError);
    expect(overrideSleep).toHaveBeenCalledWith(7);
  });

  it("fastRetryDelayMs 独立覆盖 fast 链，不改变 reason/respond 的 retryDelayMs", async () => {
    const fetchFn = vi.fn(async () => errResponse);
    const sleepFn = vi.fn(async () => {});
    const caller = createModelCaller({
      fetchFn,
      env: ENV,
      sleepFn,
      retries: 2,
      retryDelayMs: 7,
      fastRetryDelayMs: 3,
      log: () => {},
    });

    await expect(caller.call("fast", { messages: [{ role: "user", content: "x" }] }))
      .rejects.toThrow(PipelineError);
    expect(sleepFn).toHaveBeenCalledTimes(2);
    expect(sleepFn).toHaveBeenCalledWith(3);
    expect(sleepFn).not.toHaveBeenCalledWith(7);
  });

  it("fast 链显式关闭 thinking；reason 链 DeepSeek V4 Pro 开启最高推理档", async () => {
    const bodies = [];
    const fetchFn = vi.fn(async (_url, opts) => { bodies.push(JSON.parse(opts.body)); return okResponse("ok", "m"); });
    const caller = createModelCaller({ fetchFn, env: ENV, sleepFn: async () => {} });
    await caller.call("fast", { messages: [{ role: "user", content: "x" }] });
    expect(bodies[0].reasoning_effort).toBeUndefined();
    await caller.call("reason", { messages: [{ role: "user", content: "x" }] });
    expect(bodies[1].model).toBe("deepseek-v4-pro");
    expect(bodies[1].thinking).toEqual({ type: "enabled" });
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

  it("caps model input, preserves system/latest content, and emits truncation telemetry", async () => {
    let captured;
    const events = [];
    const fetchFn = vi.fn(async (_url, opts) => {
      captured = JSON.parse(opts.body);
      return okResponse("ok", "m");
    });
    const caller = createModelCaller({
      fetchFn,
      env: ENV,
      retries: 1,
      maxTokens: 16,
      maxInputTokens: 96,
      onEvent: (event) => events.push(event),
    });
    await caller.call("responder", {
      system: "核心系统规则",
      messages: [
        { role: "user", content: "旧历史".repeat(80) },
        { role: "user", content: `最新请求:${"新".repeat(50)}` },
      ],
    });

    const [systemMessage, ...messages] = captured.messages;
    expect(systemMessage.content).toBe("核心系统规则");
    expect(messages.at(-1).content).toContain("最新请求");
    expect(countModelInputTokens({ system: systemMessage.content, messages })).toBeLessThanOrEqual(80);
    expect(events).toContainEqual(expect.objectContaining({
      type: "model_input_truncated",
      chain: "responder",
      maxInputTokens: 96,
      reservedOutputTokens: 16,
    }));
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
    expect(typeof retries[0].latencyMs).toBe("number");
    const fallbacks = events.filter((e) => e.type === "model_fallback");
    expect(fallbacks).toEqual([expect.objectContaining({ chain: "fast", from: "v4-flash", to: "gpt-5.5" })]);
    // 最终成功也要记 model_call + latencyMs（成功路径可观测）
    const calls = events.filter((e) => e.type === "model_call");
    expect(calls).toEqual([expect.objectContaining({
      chain: "fast", model: "gpt-5.5", attempt: 1,
    })]);
    expect(typeof calls[0].latencyMs).toBe("number");
    expect(calls[0].latencyMs).toBeGreaterThanOrEqual(0);
  });

  it("onEvent 首次成功上报 model_call（含 latencyMs）", async () => {
    const fetchFn = vi.fn(async () => okResponse("hi", "m"));
    const events = [];
    const caller = createModelCaller({
      fetchFn, env: ENV, sleepFn: async () => {}, log: () => {},
      onEvent: (e) => events.push(e),
    });
    await caller.call("responder", { messages: [{ role: "user", content: "x" }] });
    expect(events.filter((e) => e.type === "model_retry")).toHaveLength(0);
    expect(events).toEqual([expect.objectContaining({
      type: "model_call",
      chain: "responder",
      model: "v4-pro",
      attempt: 1,
    })]);
    expect(events[0].latencyMs).toBeGreaterThanOrEqual(0);
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

  it.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY])(
    "非法 per-attempt deadline %p 在启动边界拒绝",
    (attemptTimeoutMs) => {
      expect(() => createModelCaller({ env: ENV, attemptTimeoutMs })).toThrow(/attemptTimeoutMs/);
    },
  );

  it("三条链定义与用户定案一致：Opus 全面移出备用链，DeepSeek V4 Pro 推理与出口首选", () => {
    expect(CHAINS.fast).toEqual(["v4-flash", "gpt-5.5"]);
    expect(CHAINS.reason).toEqual(["v4-pro", "gpt-5.6-sol"]);
    expect(CHAINS.improvise).toEqual(["gpt-5.6-sol"]);
    expect(CHAINS.respond).toEqual(["v4-pro", "gpt-5.6-sol"]);
  });

  it("improvise 链只调用 GPT-5.6 Sol，并锁定 medium effort", async () => {
    let captured;
    const fetchFn = vi.fn(async (url, opts) => {
      captured = { url, body: JSON.parse(opts.body) };
      return okResponse("演员台词", "gpt-5.6-sol");
    });
    const caller = createModelCaller({ fetchFn, env: ENV, retries: 1 });
    const out = await caller.call("improvise", {
      system: "你是演员",
      messages: [{ role: "user", content: "生成一句话" }],
      thinking: true,
    });
    expect(out).toMatchObject({ text: "演员台词", model: "gpt-5.6-sol" });
    expect(captured.url).toContain("api.cz900212.com");
    expect(captured.body).toMatchObject({
      model: "gpt-5.6-sol",
      reasoning_effort: "medium",
    });
  });

  it("responder/dispatcher 链名保留 legacy fast/respond 别名并强制 non-thinking", async () => {
    expect(CHAINS.responder).toEqual(CHAINS.respond);
    expect(CHAINS.dispatcher).toEqual(CHAINS.fast);

    const bodies = [];
    const fetchFn = vi.fn(async (_url, opts) => {
      bodies.push(JSON.parse(opts.body));
      return okResponse("ok", "m");
    });
    const caller = createModelCaller({ fetchFn, env: ENV, sleepFn: async () => {} });
    await caller.call("responder", { messages: [{ role: "user", content: "x" }] });
    await caller.call("dispatcher", { messages: [{ role: "user", content: "x" }] });
    expect(bodies[0].thinking).toEqual({ type: "disabled" });
    expect(bodies[0].reasoning_effort).toBeUndefined();
    expect(bodies[1].thinking).toEqual({ type: "disabled" });
    expect(bodies[1].reasoning_effort).toBeUndefined();
  });

  it("responder 与 dispatcher 各自独立上报 retry/fallback 遥测", async () => {
    let n = 0;
    const fetchFn = vi.fn(async () => {
      n += 1;
      // Each chain: first model fails once, second model succeeds.
      if (n === 1 || n === 3) return errResponse;
      return okResponse("ok", "m");
    });
    const events = [];
    const caller = createModelCaller({
      fetchFn,
      env: ENV,
      sleepFn: async () => {},
      retries: 1,
      log: () => {},
      onEvent: (e) => events.push(e),
    });

    await caller.call("dispatcher", { messages: [{ role: "user", content: "a" }] });
    await caller.call("responder", { messages: [{ role: "user", content: "b" }] });

    expect(events).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "model_retry", chain: "dispatcher", model: "v4-flash", attempt: 1 }),
      expect.objectContaining({ type: "model_fallback", chain: "dispatcher", from: "v4-flash", to: "gpt-5.5" }),
      expect.objectContaining({ type: "model_retry", chain: "responder", model: "v4-pro", attempt: 1 }),
      expect.objectContaining({ type: "model_fallback", chain: "responder", from: "v4-pro", to: "gpt-5.6-sol" }),
    ]));
  });
});

describe("per-model 纪律块注入(prompt-variants)", () => {
  const sysOf = (body) => body.messages.find((m) => m.role === "system")?.content ?? null;

  it("无 promptVariant → system 逐字节不变(dispatcher/其他链天然豁免)", async () => {
    let body;
    const fetchFn = vi.fn(async (_url, opts) => { body = JSON.parse(opts.body); return okResponse("ok", "m"); });
    const caller = createModelCaller({ fetchFn, env: ENV, sleepFn: async () => {} });
    await caller.call("dispatcher", { system: "DISPATCH_SYS", messages: [{ role: "user", content: "x" }] });
    expect(sysOf(body)).toBe("DISPATCH_SYS");
  });

  it("answer 变体 style 关 → 首答 system no-op(不破前缀缓存)", async () => {
    let body;
    const fetchFn = vi.fn(async (_url, opts) => { body = JSON.parse(opts.body); return okResponse("ok", "m"); });
    const caller = createModelCaller({ fetchFn, env: ENV, sleepFn: async () => {} });
    await caller.call("responder", { system: "ANSWER_SYS", messages: [{ role: "user", content: "x" }], promptVariant: "answer" });
    expect(sysOf(body)).toBe("ANSWER_SYS");
  });

  it("answer 变体 style 开 → 前置语体块,角色词仍在末尾", async () => {
    let body;
    const fetchFn = vi.fn(async (_url, opts) => { body = JSON.parse(opts.body); return okResponse("ok", "m"); });
    const caller = createModelCaller({ fetchFn, env: { ...ENV, MSTD_ENABLE_STYLE_BLOCK: "1" }, sleepFn: async () => {} });
    await caller.call("responder", { system: "ANSWER_SYS", messages: [{ role: "user", content: "x" }], promptVariant: "answer" });
    const s = sysOf(body);
    expect(s).toContain("# 表达纪律");
    expect(s.endsWith("ANSWER_SYS")).toBe(true);
  });

  it("handoff anti-hedge 常开;跨 fallback 每个模型都在模型循环内重新注入", async () => {
    let n = 0;
    const bodies = [];
    const fetchFn = vi.fn(async (_url, opts) => {
      bodies.push(JSON.parse(opts.body));
      n += 1;
      return n <= 5 ? errResponse : okResponse("ok", "gpt-5.6-sol");
    });
    const caller = createModelCaller({ fetchFn, env: ENV, sleepFn: async () => {}, log: () => {} });
    await caller.call("responder", { system: "HANDOFF_SYS", messages: [{ role: "user", content: "x" }], promptVariant: "handoff" });
    // responder 链 = [v4-pro, gpt-5.6-sol];bodies[0]=v4-pro 首次尝试, bodies[5]=gpt-5.6-sol 降级尝试
    expect(sysOf(bodies[0])).toContain("照实表达");
    expect(sysOf(bodies[0])).toContain("HANDOFF_SYS");
    expect(sysOf(bodies[5])).toContain("照实表达"); // 降级换模型后仍注入(块按当前模型在模型循环内重算)
    expect(sysOf(bodies[5])).toContain("HANDOFF_SYS");
  });
});

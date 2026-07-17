import { afterEach, describe, expect, it, vi } from "vitest";
import registerReply from "../pi-ext/reply.ts";
import registerTurnContext from "../pi-ext/turn-context.ts";

const { createEventBus } = await import(new URL(
  "../node_modules/@earendil-works/pi-coding-agent/dist/core/event-bus.js",
  import.meta.url,
));

describe("reply Pi extension", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env.MSTD_INTERNAL_URL;
    delete process.env.MSTD_INTERNAL_TOKEN;
    delete process.env.MSTD_SESSION_KEY;
  });

  it("requires the model to select progress/final and forwards daemon-owned turn identity", async () => {
    let tool;
    const handlers = new Map();
    const pi = {
      on: (name, handler) => handlers.set(name, handler),
      registerTool: (definition) => { tool = definition; },
      events: createEventBus(),
    };
    registerTurnContext(pi);
    registerReply(pi);
    expect(tool.parameters.required).toEqual(expect.arrayContaining(["kind", "stage", "brief"]));

    process.env.MSTD_INTERNAL_URL = "http://127.0.0.1:8899";
    process.env.MSTD_INTERNAL_TOKEN = "private-token";
    process.env.MSTD_SESSION_KEY = "feishu:p2p:ou_a";
    await handlers.get("before_agent_start")({
      prompt: "MSTD_TURN_CONTEXT_V1 turn-1 lease-1\n任务",
    });
    const fetchMock = vi.fn(async (_url, init) => ({
      ok: true,
      json: async () => ({ ok: true, text: "已发送", message_id: "om_1" }),
      init,
    }));
    vi.stubGlobal("fetch", fetchMock);

    const result = await tool.execute("call-1", {
      kind: "message",
      stage: "progress",
      brief: "处理中",
    });
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body).toMatchObject({
      session_key: "feishu:p2p:ou_a",
      turn_id: "turn-1",
      turn_lease: "lease-1",
      kind: "message",
      stage: "progress",
      brief: "处理中",
    });
    expect(JSON.stringify(tool.parameters)).not.toContain("turn_id");
    expect(JSON.stringify(tool.parameters)).not.toContain("turn_lease");
    expect(result.details).toMatchObject({
      messageId: "om_1",
      declaredStage: "progress",
      effectiveStage: "progress",
      stageCorrected: false,
    });
  });

  it("reports a server-side progress to final correction back to the reasoner", async () => {
    let tool;
    const handlers = new Map();
    const pi = {
      on: (name, handler) => handlers.set(name, handler),
      registerTool: (definition) => { tool = definition; },
      events: createEventBus(),
    };
    registerTurnContext(pi);
    registerReply(pi);
    process.env.MSTD_INTERNAL_URL = "http://127.0.0.1:8899";
    process.env.MSTD_INTERNAL_TOKEN = "private-token";
    process.env.MSTD_SESSION_KEY = "feishu:p2p:ou_a";
    await handlers.get("before_agent_start")({ prompt: "MSTD_TURN_CONTEXT_V1 turn-1 lease-1\n任务" });
    vi.stubGlobal("fetch", vi.fn(async () => ({
      ok: true,
      json: async () => ({
        ok: true,
        text: "完整答案",
        message_id: "om_final",
        declared_stage: "progress",
        effective_stage: "final",
        stage_corrected: true,
      }),
    })));

    const result = await tool.execute("call-2", {
      kind: "message",
      stage: "progress",
      brief: "完整答案",
    });

    expect(result.details).toEqual({
      messageId: "om_final",
      declaredStage: "progress",
      effectiveStage: "final",
      stageCorrected: true,
    });
    expect(result.content[0].text).toContain("有效阶段=final");
  });
});

import { afterEach, describe, expect, it, vi } from "vitest";
import { fileURLToPath } from "node:url";

const { loadExtensions } = await import(new URL(
  "../node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/loader.js",
  import.meta.url,
));

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const TURN_CONTEXT = fileURLToPath(new URL("../pi-ext/turn-context.ts", import.meta.url));
const REPLY = fileURLToPath(new URL("../pi-ext/reply.ts", import.meta.url));
const PROPOSE_ACTIONS = fileURLToPath(new URL("../pi-ext/propose-actions.ts", import.meta.url));
const BACKGROUND_JOB = fileURLToPath(new URL("../pi-ext/background-job.ts", import.meta.url));

async function loadResidentSlice() {
  const loaded = await loadExtensions([TURN_CONTEXT, REPLY, PROPOSE_ACTIONS, BACKGROUND_JOB], ROOT);
  expect(loaded.errors).toEqual([]);
  return {
    turnContext: loaded.extensions.find((extension) => extension.resolvedPath === TURN_CONTEXT),
    reply: loaded.extensions.find((extension) => extension.resolvedPath === REPLY),
    proposeActions: loaded.extensions.find((extension) => extension.resolvedPath === PROPOSE_ACTIONS),
    backgroundJob: loaded.extensions.find((extension) => extension.resolvedPath === BACKGROUND_JOB),
  };
}

function configureInternalChannel() {
  process.env.MSTD_INTERNAL_URL = "http://127.0.0.1:8899";
  process.env.MSTD_INTERNAL_TOKEN = "private-token";
  process.env.MSTD_SESSION_KEY = "feishu:p2p:ou_a";
}

describe("turn context across real Pi extension loaders", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env.MSTD_INTERNAL_URL;
    delete process.env.MSTD_INTERNAL_TOKEN;
    delete process.env.MSTD_SESSION_KEY;
  });

  it("forwards the same runtime's daemon turn identity through reply", async () => {
    const runtime = await loadResidentSlice();
    configureInternalChannel();
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({ ok: true, text: "已发送", message_id: "om_1" }),
    }));
    vi.stubGlobal("fetch", fetchMock);
    await runtime.turnContext.handlers.get("before_agent_start")[0]({
      prompt: "MSTD_TURN_CONTEXT_V1 turn-reply lease-reply\n任务",
    });

    const replyTool = runtime.reply.tools.get("reply").definition;
    await replyTool.execute("call-reply", {
      kind: "message",
      stage: "final",
      brief: "正式答案",
    });

    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toMatchObject({
      session_key: "feishu:p2p:ou_a",
      turn_id: "turn-reply",
      turn_lease: "lease-reply",
      stage: "final",
      brief: "正式答案",
    });
  });

  it("forwards the same runtime's daemon turn identity through propose_actions", async () => {
    const runtime = await loadResidentSlice();
    configureInternalChannel();
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({ ok: true, job_id: "job-1", message_id: "om_card" }),
    }));
    vi.stubGlobal("fetch", fetchMock);
    await runtime.turnContext.handlers.get("before_agent_start")[0]({
      prompt: "MSTD_TURN_CONTEXT_V1 turn-write lease-write\n任务",
    });

    const tool = runtime.proposeActions.tools.get("propose_actions").definition;
    await tool.execute("call-write", {
      title: "创建跟进任务",
      intents: [{ kind: "create_task", payload: { title: "跟进" } }],
    });

    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toMatchObject({
      session_key: "feishu:p2p:ou_a",
      turn_id: "turn-write",
      turn_lease: "lease-write",
      title: "创建跟进任务",
    });
  });

  it("forwards the same runtime's daemon turn identity through spawn_background_job", async () => {
    const runtime = await loadResidentSlice();
    configureInternalChannel();
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({ ok: true, job_id: "job-background" }),
    }));
    vi.stubGlobal("fetch", fetchMock);
    await runtime.turnContext.handlers.get("before_agent_start")[0]({
      prompt: "MSTD_TURN_CONTEXT_V1 turn-background lease-background\n任务",
    });

    const tool = runtime.backgroundJob.tools.get("spawn_background_job").definition;
    await tool.execute("call-background", {
      kind: "research",
      brief: "查供应商",
      params: { q: "供应商" },
    });

    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toMatchObject({
      session_key: "feishu:p2p:ou_a",
      turn_id: "turn-background",
      turn_lease: "lease-background",
      kind: "research",
      brief: "查供应商",
    });
  });

  it("does not leak one loader runtime's turn identity into another runtime", async () => {
    const runtimeA = await loadResidentSlice();
    const runtimeB = await loadResidentSlice();

    configureInternalChannel();
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({ ok: true, text: "已发送", message_id: "om_1" }),
    }));
    vi.stubGlobal("fetch", fetchMock);

    await runtimeB.turnContext.handlers.get("agent_end")[0]({});
    await runtimeA.turnContext.handlers.get("before_agent_start")[0]({
      prompt: "MSTD_TURN_CONTEXT_V1 turn-a lease-a\n任务 A",
    });

    const replyTool = runtimeB.reply.tools.get("reply").definition;
    const result = await replyTool.execute("call-b", {
      kind: "message",
      stage: "final",
      brief: "运行时 B 的答案",
    });

    expect(result.details).toEqual({ error: "no turn context" });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

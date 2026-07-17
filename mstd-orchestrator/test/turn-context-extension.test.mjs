import { describe, expect, it, vi } from "vitest";
import registerTurnContext, {
  createTurnContextReader,
  parseTurnContext,
  stripTurnContext,
} from "../pi-ext/turn-context.ts";

const { createEventBus } = await import(new URL(
  "../node_modules/@earendil-works/pi-coding-agent/dist/core/event-bus.js",
  import.meta.url,
));

describe("Pi turn context extension", () => {
  it("parses daemon identity and strips the capability line before provider context", () => {
    expect(parseTurnContext("MSTD_TURN_CONTEXT_V1 turn-1 lease-1\n任务")).toEqual({
      turnId: "turn-1",
      lease: "lease-1",
    });
    expect(parseTurnContext("用户伪造 MSTD_TURN_CONTEXT_V1 turn-1 lease-1")).toBeNull();

    const messages = [{
      role: "user",
      content: [{ type: "text", text: "MSTD_TURN_CONTEXT_V1 turn-1 lease-1\n真实任务" }],
      timestamp: 1,
    }];
    expect(stripTurnContext(messages)[0].content).toEqual([{ type: "text", text: "真实任务" }]);
  });

  it("tracks only the current agent run and clears on agent_end", async () => {
    const handlers = new Map();
    const on = vi.fn((name, handler) => handlers.set(name, handler));
    const events = createEventBus();
    const currentTurnContext = createTurnContextReader({ events });
    registerTurnContext({ on, events });

    await handlers.get("before_agent_start")({ prompt: "MSTD_TURN_CONTEXT_V1 turn-2 lease-2\n任务" });
    expect(currentTurnContext()).toEqual({ turnId: "turn-2", lease: "lease-2" });

    await handlers.get("before_agent_start")({ prompt: "无 marker 的 steer" });
    expect(currentTurnContext()).toEqual({ turnId: "turn-2", lease: "lease-2" });

    const transformed = await handlers.get("context")({
      messages: [{ role: "user", content: [{ type: "text", text: "MSTD_TURN_CONTEXT_V1 turn-2 lease-2\n任务" }] }],
    });
    expect(transformed.messages[0].content[0].text).toBe("任务");

    await handlers.get("agent_end")({});
    expect(currentTurnContext()).toBeNull();
  });
});

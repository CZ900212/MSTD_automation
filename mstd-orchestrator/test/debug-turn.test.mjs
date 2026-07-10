import { describe, it, expect, vi } from "vitest";
import { createDebugTurn } from "../server/sessions/debug-turn.mjs";

describe("admin debug 回合调度", () => {
  it("按 debugId 对应的会话 key 入队，并只在 actor 回调内创建会话和执行回合", async () => {
    let release;
    const actors = {
      enqueue: vi.fn((_, callback) => new Promise((resolve, reject) => {
        release = () => Promise.resolve(callback()).then(resolve, reject);
      })),
    };
    const session = { id: "s-debug" };
    const agentStore = { getOrCreate: vi.fn(() => session) };
    const handleTurn = vi.fn(async () => ({}));
    const debugTurn = createDebugTurn({ actors, agentStore, handleTurn });

    const pending = debugTurn({ debugId: "case-1", text: "检查状态", operator: "ou_admin" });
    expect(actors.enqueue).toHaveBeenCalledWith("debug:case-1", expect.any(Function));
    expect(agentStore.getOrCreate).not.toHaveBeenCalled();
    expect(handleTurn).not.toHaveBeenCalled();

    await release();
    await expect(pending).resolves.toEqual({ ok: true, sessionId: "s-debug" });
    expect(agentStore.getOrCreate).toHaveBeenCalledWith("debug:case-1", {
      kind: "debug",
      title: "[debug] ou_admin",
    });
    expect(handleTurn).toHaveBeenCalledWith({
      kind: "message",
      session,
      sessionKey: "debug:case-1",
      items: [{ content: "检查状态", senderOpenId: "ou_admin", senderName: "管理员", ts: expect.any(Number) }],
      mode: "addressed",
    });
  });
});

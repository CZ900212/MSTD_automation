import { describe, it, expect, vi } from "vitest";
import { renderReply } from "../server/models/reply.mjs";

describe("renderReply（Opus 出口渲染）", () => {
  it("走 respond 链、注入 SOUL 与上下文快照、返回终稿", async () => {
    const caller = { call: vi.fn(async () => ({ text: "终稿文案", model: "opus-4.6", usage: { total_tokens: 7 } })) };
    const out = await renderReply({
      caller,
      soul: "我是公司助手",
      context: "[张三]: 周报什么时候交",
      brief: "告诉他周五前交周报",
      kind: "message",
    });
    expect(out.text).toBe("终稿文案");
    expect(out.usage).toEqual({ total_tokens: 7 });
    const [chain, req] = caller.call.mock.calls[0];
    expect(chain).toBe("respond");
    expect(req.system).toContain("我是公司助手");
    expect(req.messages.at(-1).content).toContain("周五前交周报");
    expect(req.messages.at(-1).content).toContain("周报什么时候交");
  });

  it("card_copy 模式提示词声明卡片文案场景", async () => {
    const caller = { call: vi.fn(async () => ({ text: "卡片文案", model: "opus-4.6", usage: null })) };
    await renderReply({ caller, soul: "", context: "", brief: "确认建任务", kind: "card_copy" });
    expect(caller.call.mock.calls[0][1].system).toContain("卡片");
  });
});

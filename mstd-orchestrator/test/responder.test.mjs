import { describe, it, expect, vi } from "vitest";
import {
  createResponder,
  parseResponderOutput,
  responderPrompts,
} from "../server/models/responder.mjs";

const SOUL = "我是小达，团队的干练同事助手。";

function mockCaller(text, model = "v4-pro") {
  return {
    call: vi.fn(async () => ({ text, model, usage: { total_tokens: 11 } })),
  };
}

describe("parseResponderOutput", () => {
  it("accepts reply and no_reply only", () => {
    expect(parseResponderOutput('{"action":"reply","text":"嗨"}')).toEqual({
      action: "reply",
      text: "嗨",
    });
    expect(parseResponderOutput('{"action":"no_reply"}')).toEqual({ action: "no_reply" });
  });

  it.each([
    ['{"action":"escalate","brief":"x"}', "escalate"],
    ['{"action":"steer","note":"x"}', "steer"],
    ['{"action":"reply","text":"ok","task_id":"t1"}', "task_id"],
    ['{"action":"reply","text":"ok","needs_reasoning":true}', "needs_reasoning"],
    ['{"action":"reply","text":"ok","extra":1}', "extra"],
    ['{"action":"reply","text":"a"}{"action":"no_reply"}', "multiple"],
    ['```json\n{"action":"reply","text":"x"}\n```', "fenced"],
    ['here\n{"action":"reply","text":"x"}', "mixed"],
  ])("rejects invalid output %s", (raw) => {
    expect(() => parseResponderOutput(raw)).toThrow();
  });
});

describe("createResponder.answerTurn", () => {
  it("emits fallback telemetry without exposing provider errors", async () => {
    const onEvent = vi.fn();
    const responder = createResponder({
      caller: { call: vi.fn(async () => { throw new Error("secret provider failure"); }) },
      soul: SOUL,
      onEvent,
    });

    await expect(responder.answerTurn({
      sessionKey: "feishu:p2p:ou_x",
      items: [{ content: "在吗" }],
      mode: "p2p",
    })).resolves.toMatchObject({ action: "reply", text: expect.any(String) });
    expect(onEvent).toHaveBeenCalledWith({
      type: "responder_fallback",
      sessionKey: "feishu:p2p:ou_x",
      mode: "p2p",
      action: "reply",
    });
    expect(JSON.stringify(onEvent.mock.calls)).not.toContain("secret provider failure");
  });

  it("prompt includes SOUL and never discloses internal architecture", async () => {
    const caller = mockCaller('{"action":"reply","text":"我是小达"}');
    const responder = createResponder({ caller, soul: SOUL });
    await responder.answerTurn({
      items: [{ content: "你是谁?", senderName: "张三" }],
      mode: "p2p",
    });
    const [chain, req] = caller.call.mock.calls[0];
    expect(chain).toBe("responder");
    expect(req.system).toContain("小达");
    expect(req.system).not.toMatch(/dispatcher|reasoner|escalate|分诊|升级到慢机/i);
    expect(req.system).toContain("绝不谈论内部系统");
  });

  it("addressed/private require a non-empty reply; ambient may no_reply", async () => {
    const ok = createResponder({
      caller: mockCaller('{"action":"reply","text":"在"}'),
      soul: SOUL,
    });
    await expect(ok.answerTurn({
      items: [{ content: "在吗" }],
      mode: "addressed",
    })).resolves.toMatchObject({ action: "reply", text: "在" });

    const silent = createResponder({
      caller: mockCaller('{"action":"no_reply"}'),
      soul: SOUL,
    });
    await expect(silent.answerTurn({
      items: [{ content: "哈哈" }],
      mode: "ambient",
    })).resolves.toEqual(expect.objectContaining({ action: "no_reply" }));

    // Model tries silent on private → safe fallback reply.
    const forced = createResponder({
      caller: mockCaller('{"action":"no_reply"}'),
      soul: SOUL,
    });
    await expect(forced.answerTurn({
      items: [{ content: "在吗" }],
      mode: "p2p",
    })).resolves.toMatchObject({ action: "reply", text: expect.any(String) });
  });

  it("invalid JSON on addressed mode falls back to safe non-empty reply", async () => {
    const responder = createResponder({
      caller: mockCaller("not-json"),
      soul: SOUL,
    });
    const out = await responder.answerTurn({
      items: [{ content: "你好" }],
      mode: "private",
    });
    expect(out.action).toBe("reply");
    expect(out.text.trim().length).toBeGreaterThan(0);
  });

  it("can answer identity questions directly from SOUL", async () => {
    const caller = mockCaller('{"action":"reply","text":"我是小达，团队的同事助手。"}');
    const responder = createResponder({ caller, soul: SOUL });
    const out = await responder.answerTurn({
      items: [{ content: "你是谁？" }],
      mode: "p2p",
    });
    expect(out.action).toBe("reply");
    expect(out.text).toContain("小达");
    expect(caller.call.mock.calls[0][1].system).toContain(SOUL);
  });

  it("records provider usage metadata from the responder chain", async () => {
    const responder = createResponder({
      caller: mockCaller('{"action":"reply","text":"ok"}', "v4-pro"),
      soul: SOUL,
    });
    const out = await responder.answerTurn({
      sessionKey: "p2p:ou_x",
      items: [{ content: "hi" }],
      mode: "p2p",
    });
    expect(out.meta).toMatchObject({
      provider: "v4-pro",
      usage: { total_tokens: 11 },
      sessionKey: "p2p:ou_x",
    });
  });
});

describe("createResponder.renderHandoff", () => {
  it("forbids unsupported factual additions in the handoff prompt", async () => {
    const caller = mockCaller("已完成检查。");
    const responder = createResponder({ caller, soul: SOUL });
    await responder.renderHandoff({
      brief: "会议改到周五下午三点",
      kind: "message",
      deliverKind: "p2p",
    });
    const content = caller.call.mock.calls[0][1].messages[0].content;
    expect(content).toContain("不得添加简报未给出的事实");
    expect(content).toContain("会议改到周五下午三点");
  });

  it.each([
    ["message", "group", "群聊"],
    ["message", "p2p", "私聊"],
    ["card_copy", "group", "卡片"],
    ["card_copy", "p2p", "卡片"],
  ])("preserves kind=%s deliverKind=%s", async (kind, deliverKind, marker) => {
    const caller = mockCaller("文案");
    const responder = createResponder({ caller, soul: SOUL });
    const out = await responder.renderHandoff({
      brief: "确认建任务",
      kind,
      deliverKind,
      taskId: "task-1",
    });
    expect(out.kind).toBe(kind);
    expect(out.deliverKind).toBe(deliverKind);
    expect(caller.call.mock.calls[0][0]).toBe("responder");
    expect(caller.call.mock.calls[0][1].system).toContain(marker);
    if (kind === "card_copy") {
      expect(caller.call.mock.calls[0][1].system).not.toContain("群聊");
    }
  });

  it("uses responder chain not respond/fast aliases for new handoffs", async () => {
    const caller = mockCaller("终稿");
    const responder = createResponder({ caller, soul: "" });
    await responder.renderHandoff({ brief: "x", kind: "message", deliverKind: "group" });
    expect(caller.call.mock.calls[0][0]).toBe("responder");
  });
});

describe("responder prompt shape", () => {
  it("answer system embeds SOUL and blocks routing language", () => {
    const sys = responderPrompts.answerSystem(SOUL);
    expect(sys).toContain(SOUL);
    expect(sys).toMatch(/reply|no_reply/);
    expect(sys).not.toMatch(/请求升级|responder requested|needs_reasoning|dispatcher|reasoner/i);
  });
});

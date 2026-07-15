import { describe, it, expect, vi } from "vitest";
import {
  createResponder,
  parseProgressHandoffOutput,
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
      fallback_kind: "responder_parse",
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
    expect(out.text).toBe("收到，我先处理一下。");
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
  it("keeps a genuinely unfinished status as progress", async () => {
    const caller = mockCaller('{"effective_stage":"progress","text":"资料已经收齐，还在核对版本差异。"}');
    const responder = createResponder({ caller, soul: SOUL });
    const out = await responder.renderHandoff({
      brief: "资料已经收齐，正在核对版本差异，核对完成后再给结论",
      kind: "message",
      stage: "progress",
      deliverKind: "p2p",
    });

    expect(out).toMatchObject({
      text: "资料已经收齐，还在核对版本差异。",
      effectiveStage: "progress",
      declaredStage: "progress",
    });
    expect(caller.call.mock.calls[0][1].system).toContain("effective_stage");
    expect(caller.call.mock.calls[0][1].system).toContain("仍有明确未完成工作");
  });

  it.each([
    ["完整答案", "我倾向 TypeScript，因为现有基建可以复用。"],
    ["明确建议", "建议选方案 A，维护成本更低。"],
    ["执行结果", "任务已经创建成功。"],
    ["失败结论", "这次没有查到结果，请稍后重试。"],
  ])("promotes a mislabeled progress %s to final", async (_label, text) => {
    const caller = mockCaller(JSON.stringify({ effective_stage: "final", text }));
    const responder = createResponder({ caller, soul: SOUL });
    const out = await responder.renderHandoff({
      brief: text,
      kind: "message",
      stage: "progress",
      deliverKind: "group",
    });

    expect(out).toMatchObject({ text, effectiveStage: "final", declaredStage: "progress" });
  });

  it("fails closed when progress stage assessment is not strict JSON", async () => {
    const responder = createResponder({ caller: mockCaller("已经查完了，答案是 4。"), soul: SOUL });
    await expect(responder.renderHandoff({
      brief: "答案是 4",
      kind: "message",
      stage: "progress",
    })).rejects.toThrow(/progress handoff/i);
  });

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

describe("parseProgressHandoffOutput", () => {
  it("accepts only effective_stage + text", () => {
    expect(parseProgressHandoffOutput('{"effective_stage":"final","text":"答案"}'))
      .toEqual({ effectiveStage: "final", text: "答案" });
    expect(() => parseProgressHandoffOutput('{"effective_stage":"progress","text":"处理中","extra":1}'))
      .toThrow();
    expect(() => parseProgressHandoffOutput('```json\n{"effective_stage":"progress","text":"处理中"}\n```'))
      .toThrow();
    expect(() => parseProgressHandoffOutput('{"effective_stage":"other","text":"处理中"}'))
      .toThrow();
  });
});

describe("responder prompt shape", () => {
  it("answer system embeds SOUL and blocks routing language", () => {
    const sys = responderPrompts.answerSystem(SOUL);
    expect(sys).toContain(SOUL);
    expect(sys).toMatch(/reply|no_reply/);
    expect(sys).not.toMatch(/请求升级|responder requested|needs_reasoning|dispatcher|reasoner/i);
  });

  it("limits direct answers to known context and requires verification for new facts", () => {
    const sys = responderPrompts.answerSystem(SOUL);
    expect(sys).toMatch(/身份.*寒暄.*对话中已有信息|对话中已有信息.*身份.*寒暄/s);
    expect(sys).toMatch(/新事实.*查证.*工具.*最新数据|最新数据.*工具.*查证.*新事实/s);
    expect(sys).toMatch(/不得.*模型.*记忆.*直接作答|不能.*模型.*记忆.*直接作答/s);
    expect(sys).toMatch(/自己的话.*自然.*核实|自然.*自己的话.*核实/s);
    expect(sys).not.toMatch(/例如|比如|譬如|我查一下|我去查查|稳稳|接住/);
  });

  it("does not let the first reply answer judgment or comparison requests", () => {
    const sys = responderPrompts.answerSystem(SOUL);
    expect(sys).toMatch(/判断.*建议.*选择.*比较.*评价/s);
    expect(sys).toMatch(/不得.*首条回复.*倾向.*结论.*优劣/s);
    expect(sys).toMatch(/近期对话.*不代表.*可靠答案/s);
    expect(sys).toMatch(/后续处理.*结论/s);
  });
});

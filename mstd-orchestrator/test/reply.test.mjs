import { describe, it, expect, vi } from "vitest";
import { renderReply } from "../server/models/reply.mjs";

describe("renderReply（respond 链出口渲染）", () => {
  it("走 respond 链、注入 SOUL 与上下文快照、返回终稿", async () => {
    const caller = { call: vi.fn(async () => ({ text: "终稿文案", model: "v4-pro", usage: { total_tokens: 7 } })) };
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
    // Legacy renderReply adapter now routes through the responder chain.
    expect(chain).toBe("responder");
    expect(req.system).toContain("我是公司助手");
    expect(req.messages.at(-1).content).toContain("周五前交周报");
    expect(req.messages.at(-1).content).toContain("周报什么时候交");
  });

  it("card_copy 模式提示词声明卡片文案场景", async () => {
    const caller = { call: vi.fn(async () => ({ text: "卡片文案", model: "v4-pro", usage: null })) };
    await renderReply({ caller, soul: "", context: "", brief: "确认建任务", kind: "card_copy" });
    expect(caller.call.mock.calls[0][1].system).toContain("卡片");
  });

  // Task 10 C4/C6:投递场景感知——群短平快,私聊可展开;渲染子集向模型declare
  it("C4 deliverKind 注入长度策略;系统提示词含飞书渲染声明", async () => {
    let sys;
    const caller = { call: vi.fn(async (_chain, { system }) => { sys = system; return { text: "ok", model: "m", usage: null }; }) };
    await renderReply({ caller, brief: "x", deliverKind: "group" });
    expect(sys).toContain("群聊");
    expect(sys).toContain("三句");
    expect(sys).toContain("表格");           // 渲染声明
    expect(sys).toContain("不要输出图片");    // 明令禁止图片语法(评审修正:断言禁止句在场,与实现一致)
    expect(sys).toContain("Card JSON");
    await renderReply({ caller, brief: "x", deliverKind: "p2p" });
    expect(sys).toContain("私聊");
  });

  it("C4 deliverKind 缺省按 p2p;card_copy 不受场景影响", async () => {
    let sys;
    const caller = { call: vi.fn(async (_chain, { system }) => { sys = system; return { text: "ok", model: "m", usage: null }; }) };
    await renderReply({ caller, brief: "x" });
    expect(sys).toContain("私聊");
    await renderReply({ caller, brief: "x", kind: "card_copy", deliverKind: "group" });
    expect(sys).toContain("卡片");
    expect(sys).not.toContain("群聊");
  });

  // §5.2 审卷补杀:关键词→完整策略句+互斥+未知场景兜底+禁止矩阵整句,防语义反转
  it("C4 SCENE 完整句锁定:互斥/未知兜底===p2p/card_copy 场景不变性/渲染矩阵整句", async () => {
    const sysOf = async (args) => {
      let s;
      const caller = { call: vi.fn(async (_c, { system }) => { s = system; return { text: "ok", model: "m", usage: null }; }) };
      await renderReply({ caller, brief: "x", ...args });
      return s;
    };
    const g = await sysOf({ deliverKind: "group" });
    expect(g).toContain("本条发到群聊:默认三句话以内说完,直接给结论");
    expect(g).not.toContain("私聊");
    const p = await sysOf({ deliverKind: "p2p" });
    expect(p).toContain("本条发到私聊:可适度展开,但每句都要有信息量,不写铺垫和客套");
    expect(p).not.toContain("群聊");
    expect(await sysOf({ deliverKind: "topic-weird" })).toBe(p);   // 未知场景 === p2p 兜底
    const c1 = await sysOf({ kind: "card_copy", deliverKind: "group" });
    const c2 = await sysOf({ kind: "card_copy", deliverKind: "p2p" });
    expect(c1).toBe(c2);                                           // card_copy 与场景无关
    expect(g).toContain("支持加粗/列表/链接/代码块/表格");
    expect(g).toContain("不要输出图片语法、数学公式、HTML 或 Card JSON");
    expect(g).toContain("不编造事实,简报里没有的信息不要补");
  });
});

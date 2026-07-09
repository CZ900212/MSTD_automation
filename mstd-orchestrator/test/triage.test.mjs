import { describe, it, expect, vi } from "vitest";
import { createTriage } from "../server/models/triage.mjs";

const mkCaller = (text) => ({ call: vi.fn(async () => ({ text, model: "v4-flash", usage: null })) });
const store = { transcript: () => [] };
const session = { id: "s1", version: 0 };
const items = [{ content: "你好", senderOpenId: "ou_a", senderName: "张三", ts: 1 }];

describe("triage 四选一", () => {
  it("解析 quick_reply / no_reply / escalate / steer 四种 JSON", async () => {
    for (const [payload, expected] of [
      ['{"action":"quick_reply","text":"收到"}', { action: "quick_reply", text: "收到" }],
      ['{"action":"no_reply"}', { action: "no_reply" }],
      ['{"action":"escalate","brief":"用户要建任务"}', { action: "escalate", brief: "用户要建任务" }],
      ['{"action":"steer","note":"补充信息"}', { action: "steer", note: "补充信息" }],
    ]) {
      const t = createTriage({ caller: mkCaller(payload), store });
      expect(await t.triage({ session, items, mode: "addressed" })).toMatchObject(expected);
    }
  });

  it("caller 用 fast 链且 prompt 含发言人与 mode 标记", async () => {
    const caller = mkCaller('{"action":"no_reply"}');
    const t = createTriage({ caller, store, soul: "我是灵魂" });
    await t.triage({ session, items, mode: "ambient" });
    const [chain, req] = caller.call.mock.calls[0];
    expect(chain).toBe("fast");
    expect(req.system).toContain("我是灵魂");
    const userMsg = req.messages.at(-1).content;
    expect(userMsg).toContain("张三");
    expect(userMsg).toContain("ambient");
  });

  it("非法 JSON → 默认 escalate 不猜", async () => {
    const t = createTriage({ caller: mkCaller("我觉得应该回复他"), store });
    const out = await t.triage({ session, items, mode: "addressed" });
    expect(out.action).toBe("escalate");
  });

  it("quick_reply 超 200 字或含写意图 → 代码兜底强制 escalate", async () => {
    const long = '{"action":"quick_reply","text":"' + "长".repeat(201) + '"}';
    const t1 = createTriage({ caller: mkCaller(long), store });
    expect((await t1.triage({ session, items, mode: "addressed" })).action).toBe("escalate");

    const writey = '{"action":"quick_reply","text":"好的我帮你创建任务并发消息给李四"}';
    const t2 = createTriage({ caller: mkCaller(writey), store });
    expect((await t2.triage({ session, items, mode: "addressed" })).action).toBe("escalate");
  });
});

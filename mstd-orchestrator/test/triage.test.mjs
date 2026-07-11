import { describe, it, expect, vi } from "vitest";
import { createTriage, RECAP_INTENT, ADVICE_INTENT } from "../server/models/triage.mjs";

const mkCaller = (text) => ({ call: vi.fn(async () => ({ text, model: "v4-flash", usage: null })) });
const store = { recent: () => [] };
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

  // Task 6：近期对话走 store.recent（真"最近"），历史行语义统一——tool 永不冒充用户
  it("近期对话走 store.recent 且 tool 行标 [内部记录]", async () => {
    const caller = mkCaller('{"action":"no_reply"}');
    const recentRows = [
      { role: "tool", sender_name: "张三", content: "内部X" },
      { role: "user", sender_name: "李四", content: "早" },
      { role: "assistant", content: "早上好" },
    ];
    const recent = vi.fn(() => recentRows);
    const t = createTriage({ caller, store: { recent } });
    await t.triage({ session, items, mode: "addressed" });
    // roles 过滤是 §5.1 审核补的硬约束：system 压缩摘要不得以 [用户] 身份泄入
    expect(recent).toHaveBeenCalledWith(session.id, expect.objectContaining({
      limit: expect.any(Number), roles: ["user", "assistant", "tool"],
    }));
    const userMsg = caller.call.mock.calls[0][1].messages.at(-1).content;
    expect(userMsg).toContain("[内部记录]: 内部X");
    expect(userMsg).not.toContain("[用户]: 内部X");
    expect(userMsg).toContain("[李四]: 早");
    expect(userMsg).toContain("[我]: 早上好");
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

  // §5.2 审卷补杀:200/201 边界锁死 QUICK_REPLY_MAX 不许收紧/放宽
  it("quick_reply 恰 200 字原样保留,201 字升级", async () => {
    const t200 = createTriage({ caller: mkCaller('{"action":"quick_reply","text":"' + "长".repeat(200) + '"}'), store });
    expect(await t200.triage({ session, items, mode: "addressed" }))
      .toEqual({ action: "quick_reply", text: "长".repeat(200) });
    const t201 = createTriage({ caller: mkCaller('{"action":"quick_reply","text":"' + "长".repeat(201) + '"}'), store });
    expect((await t201.triage({ session, items, mode: "addressed" })).action).toBe("escalate");
  });

  // §5.2 审卷补杀:写意图每个分支独立触发(旧用例单输入多词互相遮蔽)
  it.each(["建任务", "创建", "新建", "删除", "修改", "取消", "发消息", "发给", "转发", "通知", "日程", "会议邀请", "提醒我", "安排", "审批", "执行"])(
    "WRITE_INTENT 分支独立触发:%s", async (w) => {
      const t = createTriage({ caller: mkCaller(`{"action":"quick_reply","text":"好的我马上${w}"}`), store });
      expect((await t.triage({ session, items, mode: "addressed" })).action).toBe("escalate");
    }
  );

  // Task 9 C4：复述/总结类靠代码 guard 强制升级——完整上下文不在分诊手里,提示词只是软约束
  it("C4 复述/总结类强制 escalate:quick_reply 和 no_reply 都拦(addressed);ambient 不拦", async () => {
    const mk = (text) => ({ call: vi.fn(async () => ({ text })) });
    const recapItems = [{ senderName: "李四", content: "[@我] 刚才群里聊了什么?复述一下" }];
    const v1 = await createTriage({ caller: mk('{"action":"quick_reply","text":"聊了吃饭"}'), store })
      .triage({ session, items: recapItems, mode: "addressed" });
    expect(v1.action).toBe("escalate");
    const v2 = await createTriage({ caller: mk('{"action":"no_reply"}'), store })
      .triage({ session, items: recapItems, mode: "addressed" });
    expect(v2.action).toBe("escalate");                        // 点名复述绝不静默
    const v3 = await createTriage({ caller: mk('{"action":"no_reply"}'), store })
      .triage({ session, items: [{ senderName: "张三", content: "谁来复述下会议?" }], mode: "ambient" });
    expect(v3.action).toBe("no_reply");                        // 旁听闲聊不强插
  });

  it("C4 分诊系统提示词包含记号说明", async () => {
    let sys;
    const caller = { call: vi.fn(async (_chain, { system }) => { sys = system; return { text: '{"action":"no_reply"}' }; }) };
    await createTriage({ caller, store }).triage({ session, items: [{ content: "哈哈" }], mode: "ambient" });
    expect(sys).toContain("[@我]");
    expect(sys).toContain("复述");
  });

  // §5.2 审卷补杀:关键词袋→方向性整句+soul 前缀恰一次,防语义反转/条目删除
  it("C4 系统提示词方向句:soul 居首恰一次,记号/复述必升级/反客服腔/身份升级全锁", async () => {
    let sys;
    const caller = { call: vi.fn(async (_chain, { system }) => { sys = system; return { text: '{"action":"no_reply"}' }; }) };
    await createTriage({ caller, store, soul: "SOUL_X_77" }).triage({ session, items: [{ content: "哈哈" }], mode: "ambient" });
    expect(sys.startsWith("SOUL_X_77")).toBe(true);
    expect(sys.split("SOUL_X_77").length - 1).toBe(1);
    expect(sys).toContain("[名字]: 是群成员发言");
    expect(sys).toContain("[@我] 表示这句话是对助手说的(只是称呼,不是话题)");
    expect(sys).toContain("复述/总结/回顾**类请求");
    expect(sys).toContain("必须升级");
    expect(sys).toContain('绝不提及"分诊/前台/模型/系统架构"');
    expect(sys).toContain("自我介绍、身份类问题一律 escalate");
    expect(sys).toContain("拿不准就 escalate");
    expect(sys).toContain("不要客服腔");
    expect(sys).toContain("mode=ambient(旁听)时保持更高沉默倾向");
    expect(sys).toContain("任何写操作意图绝不 quick_reply");
  });

  it.each(["复述一下", "总结一下", "回顾一下", "刚才聊了什么", "之前说了什么", "捋一下", "整理会议纪要"])(
    "C4 每个 recap 关键词独立触发:%s", async (content) => {
      const caller = { call: vi.fn(async () => ({ text: '{"action":"no_reply"}' })) };
      const t = createTriage({ caller, store });
      expect((await t.triage({ session, items: [{ content: `[@我] ${content}` }], mode: "addressed" })).action).toBe("escalate");
    }
  );

  // §5.1 审核采纳:写意图与 recap 同时命中时仍升级,但 brief 不得误标"复述类"误导中枢
  it("C4 写意图×recap 碰撞:escalate 且 brief 标写操作而非复述", async () => {
    const caller = { call: vi.fn(async () => ({ text: '{"action":"no_reply"}' })) };
    const v = await createTriage({ caller, store })
      .triage({ session, items: [{ content: "[@我] 提醒我明天写总结" }], mode: "addressed" });
    expect(v.action).toBe("escalate");
    expect(v.brief).toContain("写操作");
    expect(v.brief).not.toContain("复述/总结类");
  });
});

// §5.2 审卷补杀:recap guard 的行为边界——guard 只看 mode 与 items,不碰模型自主判定
describe("C4 recap guard 行为边界(§5.2 审卷补杀)", () => {
  const run = async (payload, runItems, mode = "addressed") =>
    createTriage({ caller: { call: vi.fn(async () => ({ text: payload })) }, store })
      .triage({ session, items: runItems, mode });
  const recapItems = [{ content: "[@我] 刚才群里聊了什么?复述一下" }];

  it("addressed 无 [@我] 记号(p2p 场景)同样拦:guard 只依赖 mode", async () => {
    expect((await run('{"action":"no_reply"}', [{ content: "总结一下刚才内容" }])).action).toBe("escalate");
  });

  it("模型自主 escalate/steer 带 recap 词:sentinel 对象原样保留,不被改写", async () => {
    expect(await run('{"action":"escalate","brief":"SENTINEL_BRIEF"}', recapItems))
      .toEqual({ action: "escalate", brief: "SENTINEL_BRIEF" });
    expect(await run('{"action":"steer","note":"SENTINEL_NOTE"}', recapItems))
      .toEqual({ action: "steer", note: "SENTINEL_NOTE" });
  });

  it("非法 JSON+recap items:parse 兜底 brief 原样,recap 不得先于 parse 短路", async () => {
    expect(await run("我觉得该回复", recapItems))
      .toEqual({ action: "escalate", brief: "分诊输出不可解析，升级处理" });
  });

  it("多 item 仅中间命中:整批按序拼文进 brief(前缀+slice 精确)", async () => {
    const items3 = [{ content: "早" }, { content: "帮忙总结一下" }, { content: "谢谢" }];
    const joined = "早\n帮忙总结一下\n谢谢";
    expect(await run('{"action":"no_reply"}', items3))
      .toEqual({ action: "escalate", brief: `复述/总结类请求(需完整上下文):${joined.slice(0, 100)}` });
  });

  it("ambient 豁免同样盖住 quick_reply;recap 只扫 items 不扫 verdict.text", async () => {
    expect(await run('{"action":"quick_reply","text":"好"}', [{ content: "谁来复述下" }], "ambient"))
      .toEqual({ action: "quick_reply", text: "好" });
    expect(await run('{"action":"quick_reply","text":"我总结一下哈"}', [{ content: "早上好" }]))
      .toEqual({ action: "quick_reply", text: "我总结一下哈" });
  });

  it("observe_only 非 ambient:recap 同样升级(观察期出站由 turn-handler 在动作前拦截)", async () => {
    expect((await run('{"action":"no_reply"}', [{ content: "复述一下" }], "observe_only")).action).toBe("escalate");
  });

  it("ambient 下模型自主 escalate 保留:不强插≠不许插", async () => {
    expect(await run('{"action":"escalate","brief":"值得升级"}', [{ content: "谁来复述下会议?" }], "ambient"))
      .toEqual({ action: "escalate", brief: "值得升级" });
  });
});

// §5.2 审卷补杀:RECAP_INTENT 直测——分支互不重叠正例(杀单分支删除)+时间窗/跨行边界
describe("C4 RECAP_INTENT 正则契约(§5.2 审卷补杀)", () => {
  it.each([
    ["最近大家讨论了预算", "仅时间分支"],
    ["群里都聊了什么", "仅直接问法·聊"],
    ["都说了什么", "仅直接问法·说"],
  ])("互不重叠正例命中:%s(%s)", (s) => {
    expect(RECAP_INTENT.test(s)).toBe(true);
  });

  it("时间窗 {0,12}:12 字命中,13 字不命中,跨行不命中(无 s 标志)", () => {
    expect(RECAP_INTENT.test(`刚才${"甲".repeat(12)}聊`)).toBe(true);
    expect(RECAP_INTENT.test(`刚才${"甲".repeat(13)}聊`)).toBe(false);
    expect(RECAP_INTENT.test("刚才\n讨论")).toBe(false);
  });

  it("普通消息不命中", () => {
    expect(RECAP_INTENT.test("今天天气不错,下午开会别迟到")).toBe(false);
  });
});

// 判断+解释类(ADVICE_INTENT)强制切慢机:quick_reply 结构上只能发一条,
// SOUL"观点/理由分两条发"的规矩只有中枢(reply 可多次调用)能执行
describe("判断+解释类强制切慢机(ADVICE_INTENT)", () => {
  const mk = (text) => ({ call: vi.fn(async () => ({ text })) });
  it.each(["怎么选", "选哪", "哪个好", "哪种合适", "你怎么看", "怎么看待", "你觉得", "倾向", "建议", "优劣", "利弊", "对比", "该不该", "要不要", "值不值"])(
    "ADVICE_INTENT 分支独立触发:%s", async (w) => {
      const adviceItems = [{ senderName: "李四", content: `pino 和 winston ${w}` }];
      const v = await createTriage({ caller: mk('{"action":"quick_reply","text":"用pino"}'), store })
        .triage({ session, items: adviceItems, mode: "addressed" });
      expect(v.action).toBe("escalate");
      expect(v.brief).toContain("判断/建议");
    }
  );

  it("只拦 quick_reply:no_reply 原样保留(旁听不强插);ambient 的 quick_reply 同样改道", async () => {
    const adviceItems = [{ senderName: "李四", content: "咱们该用哪个好?" }];
    const v1 = await createTriage({ caller: mk('{"action":"no_reply"}'), store })
      .triage({ session, items: adviceItems, mode: "ambient" });
    expect(v1.action).toBe("no_reply");
    const v2 = await createTriage({ caller: mk('{"action":"quick_reply","text":"pino"}'), store })
      .triage({ session, items: adviceItems, mode: "ambient" });
    expect(v2.action).toBe("escalate");
  });

  it("模型自主 escalate 带建议词:sentinel 原样保留,不被改写", async () => {
    const v = await createTriage({ caller: mk('{"action":"escalate","brief":"选型问题"}'), store })
      .triage({ session, items: [{ senderName: "李四", content: "哪个好" }], mode: "addressed" });
    expect(v.brief).toBe("选型问题");
  });

  it("普通消息不误伤", () => {
    expect(ADVICE_INTENT.test("好的,收到")).toBe(false);
    expect(ADVICE_INTENT.test("会议改到下午三点")).toBe(false);
    expect(ADVICE_INTENT.test("帮我把文档发给张三")).toBe(false);
  });
});

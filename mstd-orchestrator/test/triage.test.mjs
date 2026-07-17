import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import { createTriage, RECAP_INTENT, ADVICE_INTENT, matchLightReply, estimateTokens, budgetWindow } from "../server/models/triage.mjs";

const mkCaller = (text) => ({ call: vi.fn(async () => ({ text, model: "v4-flash", usage: null })) });
const store = { promptRecent: () => [] };
const session = { id: "s1", version: 0 };
// 注意:不能用"你好"这类轻交互整句当共享夹具——会被轻交互终止路由确定性收口,
// 遮蔽下面所有"escalate 应保留"的用例。
const items = [{ content: "帮我看下这份报告", senderOpenId: "ou_a", senderName: "张三", ts: 1 }];

// meta（provider/sourceAction/guard）是显式普通属性；形状锁断言剥掉它单独测
const bare = ({ meta, ...verdict }) => verdict;

describe("triage 四选一", () => {
  it("结构锁：升级策略由有序 ESCALATION_RULES 驱动", () => {
    const src = readFileSync(new URL("../server/models/triage.mjs", import.meta.url), "utf8");
    expect(src).toMatch(/const ESCALATION_RULES = \[/);
    expect(src).toMatch(/for \(const rule of ESCALATION_RULES\)/);
  });

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

  // P0：近期对话只走 store.promptRecent 安全 allowlist。
  it("近期对话走 store.promptRecent 且历史行语义统一", async () => {
    const caller = mkCaller('{"action":"no_reply"}');
    const recentRows = [
      { role: "tool", sender_name: "张三", content: "内部X" },
      { role: "user", sender_name: "李四", content: "早" },
      { role: "assistant", content: "早上好" },
    ];
    const promptRecent = vi.fn(() => recentRows);
    const t = createTriage({ caller, store: { promptRecent } });
    await t.triage({ session, items, mode: "addressed" });
    // roles 过滤是 §5.1 审核补的硬约束：system 压缩摘要不得以 [用户] 身份泄入
    expect(promptRecent).toHaveBeenCalledWith(session.id, expect.objectContaining({
      limit: expect.any(Number), roles: ["user", "assistant", "tool"],
    }));
    const userMsg = caller.call.mock.calls[0][1].messages.at(-1).content;
    expect(userMsg).toContain("[内部记录]: 内部X");
    expect(userMsg).not.toContain("[用户]: 内部X");
    expect(userMsg).toContain("[李四]: 早");
    expect(userMsg).toContain("[我]: 早上好");
  });

  it("严格解析只接受单一完整 JSON 或唯一 JSON fence；其余 fail closed 升级", async () => {
    for (const text of [
      "我觉得应该回复他",
      '说明 {"action":"no_reply"}',
      '{"action":"no_reply"} {"action":"quick_reply","text":"x"}',
      '前言\n```json\n{"action":"no_reply"}\n```\n后记',
      '```json\n{"action":"no_reply"}\n```\n```json\n{"action":"quick_reply","text":"x"}\n```',
      '{"action":"no_reply","unexpected":true}',
    ]) {
      const out = await createTriage({ caller: mkCaller(text), store }).triage({ session, items, mode: "addressed" });
      expect(out).toMatchObject({ action: "escalate", brief: "分诊输出不可解析，升级处理" });
    }
    const fenced = await createTriage({ caller: mkCaller(' \n```json\n{"action":"no_reply"}\n```\n'), store })
      .triage({ session, items, mode: "addressed" });
    expect(fenced.action).toBe("no_reply");
  });

  // L4L5-triage-guards(b):解析失败兜底按 mode 分叉——ambient 没人点名,fail closed
  // 不能变成无故插话;addressed/p2p 的 escalate+ack 兜底不受影响(上面用例已覆盖)。
  it("ambient 下解析失败兜底为 no_reply,不无故插话", async () => {
    const out = await createTriage({ caller: mkCaller("我觉得应该回复他"), store })
      .triage({ session, items, mode: "ambient" });
    expect(out).toMatchObject({ action: "no_reply" });
  });

  it("quick_reply 超 200 字或含写意图 → 代码兜底强制 escalate", async () => {
    const long = '{"action":"quick_reply","text":"' + "长".repeat(201) + '"}';
    const t1 = createTriage({ caller: mkCaller(long), store });
    expect((await t1.triage({ session, items, mode: "addressed" })).action).toBe("escalate");

    const writey = '{"action":"quick_reply","text":"好的我帮你创建任务并发消息给李四"}';
    const t2 = createTriage({ caller: mkCaller(writey), store });
    expect((await t2.triage({ session, items, mode: "addressed" })).action).toBe("escalate");
  });

  it.each(['{"action":"no_reply"}', '{"action":"quick_reply","text":"好的"}'])(
    "addressed 写请求不会被快机 %s 丢弃或假确认",
    async (payload) => {
      const out = await createTriage({ caller: mkCaller(payload), store })
        .triage({ session, items: [{ content: "请创建一个任务" }], mode: "addressed" });
      expect(out).toMatchObject({ action: "escalate" });
    },
  );

  // §5.2 审卷补杀:200/201 边界锁死 QUICK_REPLY_MAX 不许收紧/放宽
  it("quick_reply 恰 200 字原样保留,201 字升级", async () => {
    const t200 = createTriage({ caller: mkCaller('{"action":"quick_reply","text":"' + "长".repeat(200) + '"}'), store });
    expect(bare(await t200.triage({ session, items, mode: "addressed" })))
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
    expect(sys).toContain("快机不做任何判断");
    expect(sys).toContain("除基础算术外全部 escalate");
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

  it("模型自主 escalate/steer 带 recap 词:brief/note 原样保留;escalate 补默认 ack(快机先应答)", async () => {
    expect(bare(await run('{"action":"escalate","brief":"SENTINEL_BRIEF"}', recapItems)))
      .toEqual({ action: "escalate", brief: "SENTINEL_BRIEF", ack: "收到,我看看哈" });
    expect(bare(await run('{"action":"steer","note":"SENTINEL_NOTE"}', recapItems)))
      .toEqual({ action: "steer", note: "SENTINEL_NOTE" });
  });

  it("模型自带 ack 原样保留,不被默认值覆盖", async () => {
    expect(bare(await run('{"action":"escalate","brief":"B","ack":"这个我捋一下哈"}', recapItems)))
      .toEqual({ action: "escalate", brief: "B", ack: "这个我捋一下哈" });
  });

  it("非法 JSON+recap items:parse 兜底 brief 原样,recap 不得先于 parse 短路", async () => {
    expect(bare(await run("我觉得该回复", recapItems)))
      .toEqual({ action: "escalate", brief: "分诊输出不可解析，升级处理", ack: "收到,我看看哈" });
  });

  it("多 item 仅中间命中:整批按序拼文进 brief(前缀+slice 精确)", async () => {
    const items3 = [{ content: "早" }, { content: "帮忙总结一下" }, { content: "谢谢" }];
    const joined = "早\n帮忙总结一下\n谢谢";
    expect(bare(await run('{"action":"no_reply"}', items3)))
      .toEqual({ action: "escalate", brief: `复述/总结类请求(需完整上下文):${joined.slice(0, 100)}`, ack: "收到,我看看哈" });
  });

  it("ambient 不把旁听 recap 强改为回应；若快机已决定回答，事实边界仍强制升级", async () => {
    expect(bare(await run('{"action":"no_reply"}', [{ content: "谁来复述下" }], "ambient")))
      .toEqual({ action: "no_reply" });
    expect((await run('{"action":"quick_reply","text":"好"}', [{ content: "谁来复述下" }], "ambient")).action)
      .toBe("escalate");
    expect(bare(await run('{"action":"quick_reply","text":"我总结一下哈"}', [{ content: "早上好" }])))
      .toEqual({ action: "quick_reply", text: "我总结一下哈" });
  });

  it("observe_only 非 ambient:recap 同样升级(观察期出站由 turn-handler 在动作前拦截)", async () => {
    expect((await run('{"action":"no_reply"}', [{ content: "复述一下" }], "observe_only")).action).toBe("escalate");
  });

  it("ambient 下模型自主 escalate 保留:不强插≠不许插", async () => {
    expect(bare(await run('{"action":"escalate","brief":"值得升级"}', [{ content: "谁来复述下会议?" }], "ambient")))
      .toEqual({ action: "escalate", brief: "值得升级", ack: "收到,我看看哈" });
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

// Phase 6:meta 是显式普通属性(provider/sourceAction/guard)——事件与调试台的观测契约
describe("triage meta 内容契约", () => {
  const mk = (text) => ({ call: vi.fn(async () => ({ text, model: "v4-flash" })) });

  it("模型判定被采纳:provider/sourceAction 如实,guard=null,meta 可枚举", async () => {
    const v = await createTriage({ caller: mk('{"action":"no_reply"}'), store })
      .triage({ session, items: [{ content: "哈哈" }], mode: "ambient" });
    expect(v.meta).toEqual({ provider: "v4-flash", sourceAction: "no_reply", guard: null });
    expect(Object.keys(v)).toContain("meta");
  });

  it("代码改判:sourceAction 保留模型原判,guard 给出理由", async () => {
    const v = await createTriage({ caller: mk('{"action":"quick_reply","text":"明天交付没问题"}'), store })
      .triage({ session, items: [{ content: "你觉得这个方案靠谱吗" }], mode: "addressed" });
    expect(v.action).toBe("escalate");
    expect(v.meta).toEqual({ provider: "v4-flash", sourceAction: "quick_reply", guard: "advice_intent" });
  });

  it("caller 未带 model 时 provider=null;verdict 本体不携带 guard 中间字段", async () => {
    const v = await createTriage({ caller: { call: vi.fn(async () => ({ text: '{"action":"no_reply"}' })) }, store })
      .triage({ session, items: [{ content: "哈哈" }], mode: "ambient" });
    expect(v.meta.provider).toBeNull();
    expect(v).not.toHaveProperty("guard");
  });
});

// 2026-07-14 反向护栏:轻交互整句是确定性终止路由,快机对这类输入没有升级权限。
// 起因真机事故:"测试消息"被快机误判 escalate→慢机启动→没走 reply 工具→daemon fallback 出站。
describe("轻交互终止路由(反向护栏)", () => {
  const mk = (text) => ({ call: vi.fn(async () => ({ text, model: "v4-flash" })) });
  const run = (payload, content, mode = "addressed") =>
    createTriage({ caller: mk(payload), store }).triage({ session, items: [{ content }], mode });

  it.each(["测试消息", "测试", "ping", "在吗", "能收到吗", "[@我] 测试消息", "在吗?", "测试消息。"])(
    "模型误 escalate 也强制收口为 quick_reply:%s", async (content) => {
      const v = await run('{"action":"escalate","brief":"用户在测试","ack":"收到,我看看哈"}', content);
      expect(v.action).toBe("quick_reply");
      expect(v.text).toBeTruthy();
      expect(v.text).not.toContain("我看看");        // ack 那种"永不兑现的承诺"不许当终态回复
      expect(v.meta.guard).toBe("light_interaction");
    },
  );

  it("addressed 点名轻交互,no_reply 装聋也收口为 quick_reply", async () => {
    const v = await run('{"action":"no_reply"}', "在吗");
    expect(v).toMatchObject({ action: "quick_reply" });
  });

  it("模型自己的合规 quick_reply 文案保留(语气更贴 SOUL),越界则换模板", async () => {
    expect(bare(await run('{"action":"quick_reply","text":"能收到~有事直接说"}', "测试消息")))
      .toEqual({ action: "quick_reply", text: "能收到~有事直接说" });
    const writey = await run('{"action":"quick_reply","text":"收到,我马上删除任务"}', "测试消息");
    expect(writey.action).toBe("quick_reply");
    expect(writey.text).not.toContain("删除");
  });

  it("快机输出不可解析时,轻交互输入不再 fail-closed 升级,直接模板收口", async () => {
    expect((await run("我觉得该回复", "测试消息")).action).toBe("quick_reply");
  });

  it('"测试一下删除任务"不是整句命中,写意图照走慢机', async () => {
    const v = await run('{"action":"quick_reply","text":"好的"}', "测试一下删除任务");
    expect(v.action).toBe("escalate");
    expect(v.brief).toContain("写操作");
  });

  it("ambient 豁免:旁听群里的'在吗'不是对助手说的,保持模型判定", async () => {
    expect(bare(await run('{"action":"no_reply"}', "在吗", "ambient"))).toEqual({ action: "no_reply" });
    expect((await run('{"action":"escalate","brief":"值得升级"}', "在吗", "ambient")).action).toBe("escalate");
  });

  it("混批不收口:整批任一条是实质消息即放弃轻交互路由", async () => {
    const v = await createTriage({ caller: mk('{"action":"escalate","brief":"B"}'), store })
      .triage({ session, items: [{ content: "在吗" }, { content: "帮我删除任务X" }], mode: "addressed" });
    expect(v.action).toBe("escalate");
  });

  it("matchLightReply 契约:整句精确匹配,去 [@我] 与首尾标点,按最后一条选模板", () => {
    expect(matchLightReply([{ content: "测试消息" }])).toBe("能收到,一切正常");
    expect(matchLightReply([{ content: " [@我] 在吗？~ " }])).toBe("在的,直接说就行");
    expect(matchLightReply([{ content: "你好" }, { content: "在吗" }])).toBe("在的,直接说就行");
    expect(matchLightReply([{ content: "测试一下删除任务" }])).toBeNull();
    expect(matchLightReply([{ content: "在吗,顺便帮我查个事" }])).toBeNull();
    expect(matchLightReply([])).toBeNull();
  });
});

// 用户定案：快机不做判断；事实问答/核查除基础算术外也必须切慢机。
describe("判断与事实问题强制慢机(ADVICE_INTENT)", () => {
  const mk = (text) => ({ call: vi.fn(async () => ({ text, model: "v4-flash" })) });

  it.each(["怎么选", "选哪", "哪个好", "哪种合适", "你怎么看", "倾向", "建议"])(
    "即使模型给 quick_reply，判断题仍强制 escalate:%s", async (w) => {
      const adviceItems = [{ senderName: "李四", content: `pino 和 winston ${w}` }];
      const v = await createTriage({ caller: mk('{"action":"quick_reply","text":"我会选 pino。"}'), store })
        .triage({ session, items: adviceItems, mode: "addressed" });
      expect(v.action).toBe("escalate");
      expect(v.brief).toContain("判断或建议");
      expect(v.ack).toBeTruthy();
    }
  );

  it.each(["法国首都是什么？", "这个消息属实吗", "帮我核实一下发布日期", "现在几点?"])(
    "事实回答或核查强制 escalate:%s", async (content) => {
      const v = await createTriage({ caller: mk('{"action":"quick_reply","text":"这是事实答案。"}'), store })
        .triage({ session, items: [{ content }], mode: "addressed" });
      expect(v.action).toBe("escalate");
      expect(v.brief).toContain("事实回答或核查");
    }
  );

  it.each(["1+1等于几", "12 × 3 是多少？", "请问 8/2?"])(
    "基础算术仍允许 quick_reply:%s", async (content) => {
      const v = await createTriage({ caller: mk('{"action":"quick_reply","text":"4"}'), store })
        .triage({ session, items: [{ content }], mode: "addressed" });
      expect(v.action).toBe("quick_reply");
    }
  );

  // L4L5-triage-guards(a):addressed/p2p 下 no_reply 与 quick_reply 同样不可信——
  // 点名场景快机把事实/建议问题误判装聋,必须升级(与下面 ambient 用例对照,只动 addressed)。
  it("addressed 下 no_reply 命中判断/事实特征同样强制 escalate(点名不装聋)", async () => {
    const adviceItems = [{ senderName: "李四", content: "咱们该用哪个好?" }];
    const v1 = await createTriage({ caller: mk('{"action":"no_reply"}'), store })
      .triage({ session, items: adviceItems, mode: "addressed" });
    expect(v1.action).toBe("escalate");
    expect(v1.brief).toContain("判断或建议");

    const v2 = await createTriage({ caller: mk('{"action":"no_reply"}'), store })
      .triage({ session, items: [{ content: "现在几点?" }], mode: "addressed" });
    expect(v2.action).toBe("escalate");
    expect(v2.brief).toContain("事实回答或核查");
  });

  it("模型自主 no_reply/escalate 不被 guard 改写", async () => {
    const adviceItems = [{ senderName: "李四", content: "咱们该用哪个好?" }];
    expect((await createTriage({ caller: mk('{"action":"no_reply"}'), store })
      .triage({ session, items: adviceItems, mode: "ambient" })).action).toBe("no_reply");
    expect((await createTriage({ caller: mk('{"action":"escalate","brief":"选型问题"}'), store })
      .triage({ session, items: adviceItems, mode: "addressed" })).brief).toBe("选型问题");
  });

  it("关键词分类不误伤普通消息", () => {
    expect(ADVICE_INTENT.test("你倾向哪个")).toBe(true);
    expect(ADVICE_INTENT.test("好的,收到")).toBe(false);
    expect(ADVICE_INTENT.test("会议改到下午三点")).toBe(false);
    expect(ADVICE_INTENT.test("帮我把文档发给张三")).toBe(false);
  });
});

// 2048-token 预算窗口(用户定案):末条触界不截断,整条放入
describe("budgetWindow/estimateTokens", () => {
  it("estimateTokens:CJK≈1/字,ASCII≈1/4字符", () => {
    expect(estimateTokens("四个汉字")).toBe(4);
    expect(estimateTokens("abcdefgh")).toBe(2);
    expect(estimateTokens("")).toBe(0);
  });

  it("按预算从最新往回收,顺序保持时间正序;预算刚好用尽即停", () => {
    const rows = ["旧".repeat(10), "中".repeat(10), "新".repeat(10)];
    expect(budgetWindow(rows, { budget: 20 })).toEqual(["中".repeat(10), "新".repeat(10)]);   // 恰好用尽,旧不进
    expect(budgetWindow(rows, { budget: 25 })).toEqual(rows);                                 // 旧是触界者→整条放入
    expect(budgetWindow(rows, { budget: 100 })).toEqual(rows);
  });

  it("触界的那条整条放入不截断(窗口可略超预算)", () => {
    const rows = ["超长的一条".repeat(20), "短"];
    const win = budgetWindow(rows, { budget: 10 });
    expect(win).toEqual(["超长的一条".repeat(20), "短"]);  // 第二条(往回数)触界,整条保留
    expect(win[0].length).toBe(100);                       // 没有被截断
  });

  it("空输入返回空窗口", () => {
    expect(budgetWindow([], { budget: 100 })).toEqual([]);
  });

  it("triage 用预算窗口而非固定 20 条:store.promptRecent 上限放宽到 200", async () => {
    const promptRecent = vi.fn(() => []);
    const t = createTriage({ caller: mkCaller('{"action":"no_reply"}'), store: { promptRecent } });
    await t.triage({ session, items, mode: "ambient" });
    expect(promptRecent).toHaveBeenCalledWith("s1", expect.objectContaining({ limit: 200 }));
  });
});

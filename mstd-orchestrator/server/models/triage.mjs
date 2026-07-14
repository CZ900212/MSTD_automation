// 前台分诊：V4 Flash 四选一（quick_reply / no_reply / escalate / steer）。
// 提示词只是软约束；quick_reply 的边界由代码兜底（不信提示词）。
import { formatHistoryLine } from "../sessions/history-format.mjs";

const QUICK_REPLY_MAX = 200;
// 代码兜底强制升级时的先应答文案(快机永远先接话,用户不干等慢机;模型自主 escalate 时由模型自己写 ack)
const DEFAULT_ACK = "收到,我看看哈";
// 写意图关键词：命中即不允许 V4 直回（正式/写操作必须走中枢 reason 链）
const WRITE_INTENT = /建任务|创建|新建|删除|修改|取消|发消息|发给|转发|通知|日程|会议邀请|提醒我|安排|审批|执行/;
// C4 复述/总结意图：完整上下文不在分诊手里,点名场景下 quick_reply/no_reply 都不可信
export const RECAP_INTENT = /复述|总结|回顾|(刚才|之前|最近).{0,12}(聊|说|讨论)|聊了什么|说了什么|捋一下|会议纪要/;
// 判断/建议一律交给慢机；快机不替用户做判断。
export const ADVICE_INTENT = /怎么选|选哪|哪个(好|更|合适|靠谱)|哪种(好|合适)|你怎么看|怎么看待|你觉得|你认为|评价|推荐|倾向|建议|优劣|利弊|对比|该不该|要不要|值不值/;
// 求证/求答案默认交给慢机。快机只保留无需查证的基础算术（如 1+1 等于几）。
export const FACTUAL_QUESTION_INTENT = /[?？]|什么|多少|几(?:个|点|号|岁|天|次|钱|等于)?|谁|哪里|哪儿|何时|什么时候|为什么|为何|怎么回事|怎么样|是不是|是否|对不对|真的吗|准确吗|属实|核实|查证|确认一下|告诉我|说下|说说|介绍一下|解释一下/;
const TRIVIAL_ARITHMETIC = /^\s*(?:请问\s*)?[+-]?\d+(?:\.\d+)?\s*[+\-×xX*÷/]\s*[+-]?\d+(?:\.\d+)?\s*(?:等于|是|=)?\s*(?:多少|几|什么|\?)?\s*[？?]?\s*$/;

const ESCALATION_RULES = [
  {
    guard: "advice_intent",
    matches: ({ verdict, joined }) => verdict.action === "quick_reply" && ADVICE_INTENT.test(joined),
    brief: (joined) => `用户需要判断或建议:${joined.slice(0, 100)}`,
  },
  {
    guard: "factual_question",
    matches: ({ verdict, joined }) => verdict.action === "quick_reply"
      && FACTUAL_QUESTION_INTENT.test(joined) && !TRIVIAL_ARITHMETIC.test(joined),
    brief: (joined) => `用户需要事实回答或核查:${joined.slice(0, 100)}`,
  },
  {
    guard: "write_intent",
    matches: ({ verdict, joined, mode }) => mode !== "ambient"
      && ["quick_reply", "no_reply"].includes(verdict.action) && WRITE_INTENT.test(joined),
    brief: (joined) => `用户消息含写操作意图,需正式处理:${joined.slice(0, 100)}`,
  },
  {
    guard: "recap_or_write_intent",
    matches: ({ verdict, joined, mode }) => mode !== "ambient"
      && ["quick_reply", "no_reply"].includes(verdict.action) && RECAP_INTENT.test(joined),
    brief: (joined) => WRITE_INTENT.test(joined)
      ? `用户消息含写操作意图,需正式处理:${joined.slice(0, 100)}`
      : `复述/总结类请求(需完整上下文):${joined.slice(0, 100)}`,
  },
];

// 轻交互终止路由(2026-07-14 用户定案):完整短句精确匹配即确定性收口,模型的
// escalate/no_reply 不被接受——快机对这类输入没有升级权限。只匹配去掉 [@我] 与
// 首尾标点后的**整句**,所以"测试一下删除任务"永远不命中(仍走写意图→慢机)。
// 白名单即"无可验证慢机理由"的证明:整句精确匹配结构上排除了写/事实/建议/复述意图。
// 回复文案用 SOUL 口吻短模板(ack 不能当终态回复——"我看看"是永不兑现的承诺)。
const LIGHT_RULES = [
  { re: /^(测试消息|测试|test|ping|能收到吗|收到吗|能看到吗|收到没)$/i, reply: "能收到,一切正常" },
  { re: /^(在吗|在不在|在么|有人吗)$/i, reply: "在的,直接说就行" },
  { re: /^(你好|您好|哈喽|hello|hi|嗨|hey|早|早啊|早上好|中午好|下午好|晚上好)$/i, reply: "嗨,有事直接说哈" },
  { re: /^晚安$/i, reply: "晚安~" },
  { re: /^(谢谢|谢谢你|多谢|感谢|谢啦|辛苦了|辛苦啦)$/i, reply: "客气啦" },
  { re: /^(好的|好|好嘞|嗯|嗯嗯|ok|okay|收到|明白|了解|知道了|没问题|行)$/i, reply: "好嘞" },
];

const LIGHT_TRIM = /^[\s。．.!！?？~～,，、…]+|[\s。．.!！?？~～,，、…]+$/g;

// 整批每条都是轻交互才算命中(混入任何实质消息即放弃收口),返回按最后一条选的模板文案。
export function matchLightReply(items) {
  if (!items?.length) return null;
  let reply = null;
  for (const it of items) {
    const t = String(it.content ?? "").replace(/\[@我\]/g, " ").replace(LIGHT_TRIM, "");
    const rule = t && LIGHT_RULES.find((r) => r.re.test(t));
    if (!rule) return null;
    reply = rule.reply;
  }
  return reply;
}

const SYSTEM_TEMPLATE = (soul) => `${soul ? soul + "\n\n" : ""}你是这位助手的前台分诊员(快速模型),对每批消息输出严格 JSON,四选一:
1. {"action":"quick_reply","text":"..."} —— 只限无需判断、无需查证的机械性轻量内容:收到/回执、澄清短句，以及“1+1 等于几”这类基础算术。不超过两句话,口吻要像上面人格设定里的这个人,不要客服腔。
2. {"action":"no_reply"} —— 无需回应(闲聊旁听、与你无关、纯表情)。
3. {"action":"escalate","brief":"一句话概括用户诉求","ack":"立即先发出的一句应答"} —— 需要认真处理:任何判断/建议/选择/比较、任何事实问答或事实核查（基础算术除外）、任何写操作意图(建任务/发消息/日程等)、需要结合项目/完整历史/外部资料或工具的问题、多约束方案权衡、要求展开论证的问题、涉及第三人、正式对外内容,以及一切**复述/总结/回顾**类请求(完整上下文不在你手里,必须升级)。ack 必填:像同事先接住话,如"这个我捋一下哈,马上说"/"收到,我看看";一句话以内,绝不预告具体结论,不客服腔。
4. {"action":"steer","note":"..."} —— 上一回合还在处理中,这批消息是对进行中任务的补充/修正。
消息记号:[名字]: 是群成员发言;[@我] 表示这句话是对助手说的(只是称呼,不是话题)。
铁律:快机不做任何判断，也不回答需要事实正确性的问答；除基础算术外全部 escalate。任何写操作意图绝不 quick_reply;只输出 JSON 不要其他文字。
quick_reply 的 text 必须以助手本人口吻说话——你就是这个助手,绝不提及"分诊/前台/模型/系统架构"等内部概念;自我介绍、身份类问题一律 escalate。
mode=ambient(旁听)时保持更高沉默倾向:只在能提供明确价值(直接求助、你确切知道答案、纠正重要错误)时开口,闲聊/寒暄/与你无关一律 no_reply。`;

function renderItems(items) {
  return items
    .map((m) => `[${m.senderName ?? m.senderOpenId ?? "未知"}]: ${m.content}`)
    .join("\n");
}

// 自然参与上下文窗口(用户定案 2026-07-12):token 估算,CJK≈1 token/字、ASCII≈1 token/4 字符
export function estimateTokens(text) {
  let t = 0;
  for (const ch of String(text)) t += ch.charCodeAt(0) > 0x2e7f ? 1 : 0.25;
  return Math.ceil(t);
}

// 按预算从最新往回收消息;触界的那条**整条放入不截断**(窗口可略超预算),然后停
export function budgetWindow(rows, { budget = 2048, format = (r) => String(r) } = {}) {
  const out = [];
  let used = 0;
  for (let i = rows.length - 1; i >= 0; i--) {
    const line = format(rows[i]);
    out.unshift(line);
    used += estimateTokens(line);
    if (used >= budget) break;
  }
  return out;
}

export function createTriage({ caller, store, soul = "", windowTokens = 2048 }) {
  async function triage({ session, items, mode, snapshot = null, brainBusy = false }) {
    // C3.2:近期语义用 store.recent(transcript 取的是最早 n 条),历史行走统一 helper;
    // 排除 system——压缩摘要不得以 [用户] 身份泄入分诊上下文。
    // 上限 200 行只是 SQL 取数保护,真正的边界是 token 预算窗口
    const rows = store.recent(session.id, { limit: 200, roles: ["user", "assistant", "tool"] });
    const recent = budgetWindow(rows, { budget: windowTokens, format: formatHistoryLine }).join("\n");
    const memoryBlock = snapshot
      ? `\n## 记忆快照\n${[snapshot.org, snapshot.scoped].filter(Boolean).join("\n")}`
      : "";
    const prompt = [
      `## 场景`,
      `mode=${mode}${brainBusy ? "（中枢正在处理上一任务）" : ""}`,
      memoryBlock,
      recent ? `## 近期对话\n${recent}` : "",
      `## 新消息批`,
      renderItems(items),
      `请输出 JSON 判定。`,
    ].filter(Boolean).join("\n");

    const soulText = snapshot?.soul ?? soul;
    const out = await caller.call("fast", {
      system: SYSTEM_TEMPLATE(soulText),
      messages: [{ role: "user", content: prompt }],
    });

    const parsed = parse(out.text);
    // guard 是 enforce 的改判理由（中间字段），只经 meta 出场——verdict 本体保持四选一契约字段。
    const { guard = null, ...verdict } = enforce(parsed, items, mode);
    verdict.meta = {
      provider: out.model ?? null,
      sourceAction: parsed.action,
      guard: verdict.action !== parsed.action ? (guard ?? "code_guard") : null,
    };
    // 快机永远先应答(用户定案 2026-07-12):escalate 一律带 ack,模型漏写则兜底
    if (verdict.action === "escalate" && !(typeof verdict.ack === "string" && verdict.ack.trim())) {
      verdict.ack = DEFAULT_ACK;
    }
    return verdict;
  }

  function parse(text) {
    try {
      if (typeof text !== "string" || !text.trim()) throw new Error("empty json");
      const trimmed = text.trim();
      const fence = /^```json[ \t]*\r?\n([\s\S]*?)\r?\n?```$/i.exec(trimmed);
      const candidate = fence ? fence[1].trim() : trimmed;
      const j = JSON.parse(candidate);
      const allowed = new Set(["action", "text", "brief", "ack", "note"]);
      if (!j || typeof j !== "object" || Array.isArray(j)
        || Object.keys(j).some((key) => !allowed.has(key))
        || !["quick_reply", "no_reply", "escalate", "steer"].includes(j.action)) throw new Error("bad schema");
      const required = {
        quick_reply: ["action", "text"],
        no_reply: ["action"],
        escalate: ["action", "brief"],
        steer: ["action", "note"],
      }[j.action];
      if (Object.keys(j).some((key) => !required.includes(key) && !(j.action === "escalate" && key === "ack"))) throw new Error("unexpected field");
      if (j.action !== "no_reply" && required.some((key) => typeof j[key] !== "string" || !j[key].trim())) throw new Error("missing field");
      if (j.action === "escalate" && j.ack != null && (typeof j.ack !== "string" || !j.ack.trim())) throw new Error("bad ack");
      return j;
    } catch {
      return { action: "escalate", brief: "分诊输出不可解析，升级处理", ack: DEFAULT_ACK };
    }
  }

  const guarded = (verdict, reason) => ({ ...verdict, guard: reason });

  // 代码兜底：快机只处理机械回执/澄清与基础算术；判断、事实问答、复述和写操作强制升级。
  function enforce(verdict, items, mode) {
    const joined = items.map((i) => i.content).join("\n");
    // 反向护栏(2026-07-14):轻交互整句在 addressed/p2p 下确定性终止——模型的
    // escalate(误升级启动慢机→daemon fallback)和 no_reply(点名装聋)都不被接受。
    // 模型自己的 quick_reply 文案若合规则保留(语气更贴 SOUL),越界则换安全模板。
    // ambient 豁免:旁听群里别人说"在吗"不是对助手说的,保持模型的沉默倾向。
    // 此路由先于问答/建议正则:白名单整句(如"在吗?")不允许被标点误伤强制升级。
    if (mode !== "ambient") {
      const light = matchLightReply(items);
      if (light) {
        const t = verdict.action === "quick_reply" ? (verdict.text ?? "").trim() : "";
        const keep = t && t.length <= QUICK_REPLY_MAX && !WRITE_INTENT.test(t);
        if (verdict.action === "quick_reply" && keep) return verdict;
        return guarded({ action: "quick_reply", text: keep ? t : light }, "light_interaction");
      }
    }
    // ambient 保持沉默权；实际回答仍过能力边界。规则顺序即优先级。
    for (const rule of ESCALATION_RULES) {
      if (rule.matches({ verdict, joined, mode })) {
        return guarded(
          { action: "escalate", brief: rule.brief(joined), ack: DEFAULT_ACK },
          rule.guard,
        );
      }
    }
    if (verdict.action !== "quick_reply") return verdict;
    if ((verdict.text ?? "").length > QUICK_REPLY_MAX || WRITE_INTENT.test(verdict.text ?? "")) {
      return guarded(
        { action: "escalate", brief: `用户消息需正式处理：${items.map((i) => i.content).join("；").slice(0, 100)}`, ack: DEFAULT_ACK },
        (verdict.text ?? "").length > QUICK_REPLY_MAX ? "quick_reply_too_long" : "write_intent_in_reply",
      );
    }
    return verdict;
  }

  return { triage };
}

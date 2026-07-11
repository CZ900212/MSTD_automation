// 前台分诊：V4 Flash 四选一（quick_reply / no_reply / escalate / steer）。
// 提示词只是软约束；quick_reply 的边界由代码兜底（不信提示词）。
import { formatHistoryLine } from "../sessions/history-format.mjs";

const QUICK_REPLY_MAX = 200;
// 写意图关键词：命中即不允许 V4 直回（正式/写操作必须走 5.5→Opus）
const WRITE_INTENT = /建任务|创建|新建|删除|修改|取消|发消息|发给|转发|通知|日程|会议邀请|提醒我|安排|审批|执行/;
// C4 复述/总结意图：完整上下文不在分诊手里,点名场景下 quick_reply/no_reply 都不可信
export const RECAP_INTENT = /复述|总结|回顾|(刚才|之前|最近).{0,12}(聊|说|讨论)|聊了什么|说了什么|捋一下|会议纪要/;
// 判断+解释意图：需要给观点并说理由的问题。quick_reply 结构上只能发一条,
// SOUL 的"观点/理由分两条发"规矩只有中枢(reply 可多次调用)能执行 → 强制切慢机
export const ADVICE_INTENT = /怎么选|选哪|哪个(好|更|合适|靠谱)|哪种(好|合适)|你怎么看|怎么看待|你觉得|倾向|建议|优劣|利弊|对比|该不该|要不要|值不值/;

const SYSTEM_TEMPLATE = (soul) => `${soul ? soul + "\n\n" : ""}你是这位助手的前台分诊员(快速模型),对每批消息输出严格 JSON,四选一:
1. {"action":"quick_reply","text":"..."} —— 仅限轻量内容:收到/回执、澄清短句、一句话事实。不超过两句话,口吻要像上面人格设定里的这个人,不要客服腔。凡是需要"给判断+解释理由"的问题(选型/建议/权衡利弊/你怎么看)一律不许 quick_reply。
2. {"action":"no_reply"} —— 无需回应(闲聊旁听、与你无关、纯表情)。
3. {"action":"escalate","brief":"一句话概括用户诉求"} —— 需要认真处理:任何写操作意图(建任务/发消息/日程等)、**需要判断+解释的问题**(选型/建议/方案权衡/征求看法)、复杂问题、涉及第三人、正式对外内容、需要查资料,以及一切**复述/总结/回顾**类请求(完整上下文不在你手里,必须升级)。
4. {"action":"steer","note":"..."} —— 上一回合还在处理中,这批消息是对进行中任务的补充/修正。
消息记号:[名字]: 是群成员发言;[@我] 表示这句话是对助手说的(只是称呼,不是话题)。
铁律:拿不准就 escalate;任何写操作意图绝不 quick_reply;只输出 JSON 不要其他文字。
quick_reply 的 text 必须以助手本人口吻说话——你就是这个助手,绝不提及"分诊/前台/模型/系统架构"等内部概念;自我介绍、身份类问题一律 escalate。
mode=ambient(旁听)时保持更高沉默倾向:只在能提供明确价值(直接求助、你确切知道答案、纠正重要错误)时开口,闲聊/寒暄/与你无关一律 no_reply。`;

function renderItems(items) {
  return items
    .map((m) => `[${m.senderName ?? m.senderOpenId ?? "未知"}]: ${m.content}`)
    .join("\n");
}

export function createTriage({ caller, store, soul = "" }) {
  async function triage({ session, items, mode, snapshot = null, brainBusy = false }) {
    // C3.2:近期语义用 store.recent(transcript 取的是最早 n 条),历史行走统一 helper;
    // 排除 system——压缩摘要不得以 [用户] 身份泄入分诊上下文
    const recent = store.recent(session.id, { limit: 20, roles: ["user", "assistant", "tool"] })
      .map(formatHistoryLine).join("\n");
    const memoryBlock = snapshot
      ? `\n## 记忆快照\n${[snapshot.org, snapshot.journalDigest, snapshot.scoped].filter(Boolean).join("\n")}`
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

    return enforce(parse(out.text), items, mode);
  }

  function parse(text) {
    try {
      const m = text.match(/\{[\s\S]*\}/);
      if (!m) throw new Error("no json");
      const j = JSON.parse(m[0]);
      if (!["quick_reply", "no_reply", "escalate", "steer"].includes(j.action)) throw new Error("bad action");
      return j;
    } catch {
      return { action: "escalate", brief: "分诊输出不可解析，升级处理" };
    }
  }

  // 代码兜底：直回超长或含写意图 → 强制升级
  function enforce(verdict, items, mode) {
    // C4:点名场景的复述/总结类,quick_reply(答不全)和 no_reply(静默)都拦;
    // ambient 豁免——旁听闲聊里的"谁来复述下"不强插(评审修正)
    const joined = items.map((i) => i.content).join("\n");
    if (mode !== "ambient" && ["quick_reply", "no_reply"].includes(verdict.action) && RECAP_INTENT.test(joined)) {
      // §5.1 审核采纳:"提醒我明天写总结"同时命中写意图与 recap——不硬贴复述标签误导中枢
      const brief = WRITE_INTENT.test(joined)
        ? `用户消息含写操作意图,需正式处理:${joined.slice(0, 100)}`
        : `复述/总结类请求(需完整上下文):${joined.slice(0, 100)}`;
      return { action: "escalate", brief };
    }
    if (verdict.action !== "quick_reply") return verdict;
    // 判断+解释类强制切慢机(只拦 quick_reply:分诊已决定开口,改道中枢而已,ambient 不豁免)
    if (ADVICE_INTENT.test(joined)) {
      return { action: "escalate", brief: `判断/建议类问题,需观点+理由分条回复：${joined.slice(0, 100)}` };
    }
    if ((verdict.text ?? "").length > QUICK_REPLY_MAX || WRITE_INTENT.test(verdict.text ?? "")) {
      return { action: "escalate", brief: `用户消息需正式处理：${items.map((i) => i.content).join("；").slice(0, 100)}` };
    }
    return verdict;
  }

  return { triage };
}

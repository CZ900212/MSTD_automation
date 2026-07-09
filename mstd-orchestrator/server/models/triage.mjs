// 前台分诊：V4 Flash 四选一（quick_reply / no_reply / escalate / steer）。
// 提示词只是软约束；quick_reply 的边界由代码兜底（不信提示词）。

const QUICK_REPLY_MAX = 200;
// 写意图关键词：命中即不允许 V4 直回（正式/写操作必须走 5.5→Opus）
const WRITE_INTENT = /建任务|创建|新建|删除|修改|取消|发消息|发给|转发|通知|日程|会议邀请|提醒我|安排|审批|执行/;

const SYSTEM_TEMPLATE = (soul) => `${soul ? soul + "\n\n" : ""}你是常驻飞书助手的前台分诊员（快速模型）。对每批消息输出严格 JSON，四选一：
1. {"action":"quick_reply","text":"..."} —— 仅限轻量内容：收到/回执、澄清短句、一句话事实。不超过两句话。
2. {"action":"no_reply"} —— 无需回应（闲聊旁听、与你无关、纯表情）。
3. {"action":"escalate","brief":"一句话概括用户诉求"} —— 需要认真处理：任何写操作意图（建任务/发消息/日程等）、复杂问题、涉及第三人、正式对外内容、需要查资料。
4. {"action":"steer","note":"..."} —— 上一回合还在处理中，这批消息是对进行中任务的补充/修正。
铁律：拿不准就 escalate；任何写操作意图绝不 quick_reply；只输出 JSON 不要其他文字。`;

function renderItems(items) {
  return items
    .map((m) => `[${m.senderName ?? m.senderOpenId ?? "未知"}]: ${m.content}`)
    .join("\n");
}

export function createTriage({ caller, store, soul = "" }) {
  async function triage({ session, items, mode, snapshot = null, brainBusy = false }) {
    const recent = store.transcript(session.id, { limit: 20 })
      .map((m) => `[${m.role === "assistant" ? "我" : m.sender_name ?? m.sender_open_id ?? "用户"}]: ${m.content}`)
      .join("\n");
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

    return enforce(parse(out.text), items);
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
  function enforce(verdict, items) {
    if (verdict.action !== "quick_reply") return verdict;
    if ((verdict.text ?? "").length > QUICK_REPLY_MAX || WRITE_INTENT.test(verdict.text ?? "")) {
      return { action: "escalate", brief: `用户消息需正式处理：${items.map((i) => i.content).join("；").slice(0, 100)}` };
    }
    return verdict;
  }

  return { triage };
}

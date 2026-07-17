// Always-available public voice: first-reply + reasoner handoff rendering.
// The responder never requests escalation and never selects a reasoner.
import { formatNow } from "../time/now.mjs";

const SAFE_ADDRESSED_FALLBACK = "收到，我先处理一下。";
const REPLY_MAX = 4000;
const AMBIENT_REPLY_REASONS = new Set(["direct_address", "open_request", "important_correction"]);
const AMBIENT_SILENCE_REASONS = new Set(["human_conversation", "social_chatter", "unclear_addressee", "reaction_or_emoji"]);

const SCENE = {
  group: "本条发到群聊:默认三句话以内说完,直接给结论;超过三句必须是信息密度撑得起的。",
  p2p: "本条发到私聊:可适度展开,但每句都要有信息量,不写铺垫和客套。",
};

const PROGRESS_SCENE = {
  group: "本条发到群聊:默认三句话以内说完,只说当前状态与尚未完成的下一步。",
  p2p: "本条发到私聊:简洁说明当前状态与尚未完成的下一步,不写铺垫和客套。",
};

const ANSWER_SYSTEM = (soul) => `${soul ? `${soul}\n\n` : ""}你是这位助手本人，直接对用户说话。
对每批消息输出严格 JSON，二选一:
1. {"action":"reply","text":"...","reason_code":"..."} —— 给用户的正式回复（完整答案或诚实的临时答复均可）。
2. {"action":"no_reply","reason_code":"..."} —— 无需开口（旁听闲聊、与你无关、纯表情）。

规则:
- 点名/私聊场景通常应 reply，不要装聋。
- 旁听(mode=ambient)必须先判断“这句话是在对谁说”，再判断自己是否有价值。不要把“你能接话”误当成“对方在和你说话”。
- 称呼了其他人的名字后，后续省略主语的承接、反问、打趣、感叹和短句，默认仍属于人与人的对话，直到出现明确转向；这种情况 no_reply。
- 没有明确受话人的短句、代词承接、语气词、普通寒暄、社交邀约和日常闲聊默认 no_reply；无法确定受话对象时也 no_reply。
- ambient 只在三类情况开口：明确叫你或向你提问(reason_code=direct_address)；没有指向其他人的开放求助/群体问题(reason_code=open_request)；不纠正会造成明显损失的重要错误(reason_code=important_correction)。
- ambient 沉默原因只能是：人与人对话(human_conversation)、普通闲聊(social_chatter)、受话人不明(unclear_addressee)、纯反应或表情(reaction_or_emoji)。
- 需要先核实、暂时答不全本身不是 ambient 沉默理由；但前提仍是消息确实面向你或属于开放求助。
- 口吻必须是上面人格设定里的这个人，不要客服腔。
- 身份、寒暄或对话中已有信息，可以直接完整回答。
- 涉及新事实、需要查证、需要工具或最新数据时，不得凭模型参数记忆直接作答；必须用自己的话自然说明要先核实，由后续处理带回事实结果。
- 用户要求判断、建议、选择、比较或评价时，也不得在首条回复里直接给倾向、结论、优劣或支撑这些结论的新事实；必须自然说明要先分析核实，由后续处理带回结论。近期对话里出现过问题，不代表其中已经有可靠答案。
- 用户可见文案中绝不谈论内部系统、路由、模型分层或实现细节。
- 非 ambient 场景的 reason_code 用简短 snake_case 描述依据。
- 只输出一个 JSON 对象，不要 Markdown 围栏，不要额外文字。
- 除 action/text/reason_code 外不要添加任何字段。`;

const HANDOFF_SYSTEM = ({ soul, kind, deliverKind }) => `${soul ? `${soul}\n\n` : ""}你是团队的对外表达出口(执笔人)。${
  kind === "card_copy"
    ? "本次产出飞书确认卡片的文案槽位内容:简洁说明将要执行的操作与关键参数,让确认人一眼看懂。"
    : `本次产出发给用户的正式消息成品。${SCENE[deliverKind] ?? SCENE.p2p}`
}
要求:自然中文,像同事说话,不用模板腔;直接输出成品文本,不加解释、不加引号;不编造事实,简报里没有的信息不要补。
飞书渲染约定:支持加粗/列表/链接/代码块/表格(含 Markdown 时系统会自动走卡片渲染,放心输出规范 Markdown);表格一律用规范 md 表格语法;不要输出图片语法、数学公式、HTML 或 Card JSON(飞书渲染不了或结构由服务端负责)。`;

const PROGRESS_HANDOFF_SYSTEM = ({ soul, deliverKind }) => `${soul ? `${soul}\n\n` : ""}你是团队的对外表达出口(执笔人)，同时负责检查这份简报是否真的是非终态进度。${PROGRESS_SCENE[deliverKind] ?? PROGRESS_SCENE.p2p}
输出严格 JSON，且只能包含两个字段:
{"effective_stage":"progress|final","text":"发给用户的消息成品"}

阶段判定:
- 只有仍有明确未完成工作，而且本条不包含用户所求的答案、结论、建议、执行结果、失败结果或取消状态时，effective_stage 才能是 progress。
- 简报已经回答用户问题、给出结论或建议、报告操作结果，或给出失败/取消等收口状态时，即使调用方声明 progress，也必须判为 final。
- 不得为了保留 progress 而隐去简报中已经存在的答案；应完整表达简报，并把 effective_stage 判为 final。

文案要求:自然中文,像同事说话,不用模板腔;不编造事实,简报里没有的信息不要补。
飞书渲染约定:支持加粗/列表/链接/代码块/表格;不要输出图片语法、数学公式、HTML 或 Card JSON。
只输出一个 JSON 对象，不要 Markdown 围栏，不要额外文字。`;

function renderItems(items) {
  return (items ?? [])
    .map((m) => `[${m.senderName ?? m.senderOpenId ?? "未知"}]: ${m.content}`)
    .join("\n");
}

/** Strict parser for responder foreground output. Rejects routing fields and mixed fences. */
export function parseResponderOutput(text, { mode = null } = {}) {
  if (typeof text !== "string" || !text.trim()) throw new Error("empty responder output");
  const trimmed = text.trim();
  // Reject fenced output — foreground contract is a single bare JSON object.
  // 只拦"整体被围栏包裹"（startsWith）：提示词明确支持回复正文含代码块，
  // JSON 字符串值内部的 ``` 是合法内容，不得整体判失败。
  if (trimmed.startsWith("```")) {
    throw new Error("fenced responder output");
  }
  const j = JSON.parse(trimmed);
  if (!j || typeof j !== "object" || Array.isArray(j)) throw new Error("bad responder schema");
  const allowed = new Set(["action", "text", "reason_code"]);
  if (Object.keys(j).some((key) => !allowed.has(key))) throw new Error("unexpected responder field");
  if (!["reply", "no_reply"].includes(j.action)) throw new Error("unsupported responder action");
  const reasonCode = typeof j.reason_code === "string" ? j.reason_code.trim() : "";
  if (mode === "ambient" && !reasonCode) throw new Error("ambient reason_code required");
  if (j.action === "no_reply") {
    if (Object.keys(j).some((key) => !["action", "reason_code"].includes(key))) throw new Error("no_reply fields invalid");
    if (mode === "ambient" && !AMBIENT_SILENCE_REASONS.has(reasonCode)) throw new Error("bad ambient silence reason_code");
    return { action: "no_reply", ...(reasonCode ? { reason_code: reasonCode } : {}) };
  }
  if (typeof j.text !== "string" || !j.text.trim()) throw new Error("reply requires non-empty text");
  if (j.text.length > REPLY_MAX) throw new Error("reply text too long");
  if (mode === "ambient" && !AMBIENT_REPLY_REASONS.has(reasonCode)) throw new Error("bad ambient reply reason_code");
  return { action: "reply", text: j.text.trim(), ...(reasonCode ? { reason_code: reasonCode } : {}) };
}

/** Strict parser for stage-aware progress handoff output. */
export function parseProgressHandoffOutput(text) {
  if (typeof text !== "string" || !text.trim()) throw new Error("empty progress handoff output");
  const trimmed = text.trim();
  // 同 parseResponderOutput：围栏守卫收窄到整体包裹；正文内代码块合法（提示词自宣支持）
  if (trimmed.startsWith("```")) {
    throw new Error("fenced progress handoff output");
  }
  let j;
  try {
    j = JSON.parse(trimmed);
  } catch (error) {
    throw new Error(`invalid progress handoff JSON: ${error?.message ?? error}`);
  }
  if (!j || typeof j !== "object" || Array.isArray(j)) throw new Error("bad progress handoff schema");
  const keys = Object.keys(j);
  if (keys.length !== 2 || !keys.includes("effective_stage") || !keys.includes("text")) {
    throw new Error("progress handoff must contain effective_stage and text only");
  }
  if (j.effective_stage !== "progress" && j.effective_stage !== "final") {
    throw new Error("unsupported progress handoff stage");
  }
  if (typeof j.text !== "string" || !j.text.trim()) throw new Error("progress handoff requires non-empty text");
  if (j.text.length > REPLY_MAX) throw new Error("progress handoff text too long");
  return { effectiveStage: j.effective_stage, text: j.text.trim() };
}

function isAddressedOrPrivate(mode) {
  return mode === "addressed" || mode === "p2p" || mode === "private";
}

/**
 * Create the always-available responder.
 * @param {{ caller: { call: Function }, soul?: string }} opts
 */
export function createResponder({ caller, soul = "", onEvent = null, now = () => new Date() } = {}) {
  if (!caller || typeof caller.call !== "function") {
    throw new Error("createResponder: caller.call 必填");
  }

  async function answerTurn({
    sessionKey = null,
    items = [],
    mode = "p2p",
    soul: soulOverride,
    recentConversation = "",
    snapshot = null,
  } = {}) {
    const soulText = soulOverride ?? snapshot?.soul ?? soul;
    const prompt = [
      `## 当前时间\n现在是 ${formatNow(now)}`,
      `## 场景`,
      `mode=${mode}`,
      recentConversation ? `## 近期对话\n${recentConversation}` : "",
      `## 新消息批`,
      renderItems(items),
      `请输出 JSON。`,
    ].filter(Boolean).join("\n");

    let out = null;
    let verdict;
    try {
      out = await caller.call("responder", {
        system: ANSWER_SYSTEM(soulText),
        messages: [{ role: "user", content: prompt }],
        promptVariant: "answer",
      });
      verdict = parseResponderOutput(out.text, { mode });
    } catch {
      verdict = isAddressedOrPrivate(mode)
        ? { action: "reply", text: SAFE_ADDRESSED_FALLBACK, reason_code: "parse_fallback" }
        : { action: "no_reply", reason_code: "unclear_addressee" };
      try {
        onEvent?.({
          type: "responder_fallback",
          fallback_kind: "responder_parse",
          sessionKey,
          mode,
          action: verdict.action,
        });
      } catch { /* telemetry must never break the public fallback */ }
    }

    // Addressed/private must not stay silent after a successful parse of no_reply either.
    if (isAddressedOrPrivate(mode) && verdict.action === "no_reply") {
      verdict = { action: "reply", text: SAFE_ADDRESSED_FALLBACK, reason_code: "addressed_fallback" };
    }
    if (verdict.action === "reply" && !verdict.text.trim()) {
      verdict = { action: "reply", text: SAFE_ADDRESSED_FALLBACK, reason_code: "empty_reply_fallback" };
    }

    const { reason_code: reasonCode = null, ...publicVerdict } = verdict;

    return {
      ...publicVerdict,
      meta: {
        provider: out?.model ?? null,
        usage: out?.usage ?? null,
        sessionKey,
        reasonCode,
      },
    };
  }

  /**
   * Render a reasoner handoff brief into user-facing text.
   * Preserves kind (message|card_copy) and deliverKind (group|p2p); never invents facts.
   */
  async function renderHandoff({
    sessionKey = null,
    taskId = null,
    brief,
    tone = "",
    kind = "message",
    stage = "final",
    deliverKind = "p2p",
    recentConversation = "",
    soul: soulOverride,
    context = "",
  } = {}) {
    if (typeof brief !== "string" || !brief.trim()) {
      throw new Error("renderHandoff: brief 必填");
    }
    const soulText = soulOverride ?? soul;
    const user = [
      (recentConversation || context) ? `## 会话上下文\n${recentConversation || context}` : "",
      `## 简报（要表达的内容）\n${brief}`,
      tone ? `## 语气要求\n${tone}` : "",
      "铁律:只转述简报中的事实与决定,不得添加简报未给出的事实、数字、人名、结论。",
    ].filter(Boolean).join("\n\n");

    const stageAwareProgress = kind === "message" && stage === "progress";
    const out = await caller.call("responder", {
      system: stageAwareProgress
        ? PROGRESS_HANDOFF_SYSTEM({ soul: soulText, deliverKind })
        : HANDOFF_SYSTEM({ soul: soulText, kind, deliverKind }),
      messages: [{ role: "user", content: user }],
      promptVariant: "handoff",
    });

    const assessed = stageAwareProgress
      ? parseProgressHandoffOutput(out.text)
      : { text: out.text, effectiveStage: stage === "final" ? "final" : stage };

    return {
      text: assessed.text,
      model: out.model,
      usage: out.usage,
      kind,
      declaredStage: stage,
      effectiveStage: assessed.effectiveStage,
      deliverKind,
      meta: { sessionKey, taskId, provider: out.model ?? null },
    };
  }

  return {
    answerTurn,
    renderHandoff,
    parseResponderOutput,
    SAFE_ADDRESSED_FALLBACK,
  };
}

/** Prompt builders exported for shape tests. */
export const responderPrompts = {
  answerSystem: ANSWER_SYSTEM,
  handoffSystem: HANDOFF_SYSTEM,
  progressHandoffSystem: PROGRESS_HANDOFF_SYSTEM,
  scene: SCENE,
};

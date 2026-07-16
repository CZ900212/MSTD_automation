// Always-available public voice: first-reply + reasoner handoff rendering.
// The responder never requests escalation and never selects a reasoner.

const SAFE_ADDRESSED_FALLBACK = "收到，我先处理一下。";
const REPLY_MAX = 4000;

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
1. {"action":"reply","text":"..."} —— 给用户的正式回复（完整答案或诚实的临时答复均可）。
2. {"action":"no_reply"} —— 无需开口（旁听闲聊、与你无关、纯表情）。

规则:
- 点名/私聊场景通常应 reply，不要装聋。
- 旁听(mode=ambient)保持更高沉默倾向:只有明确价值时才开口。
- 口吻必须是上面人格设定里的这个人，不要客服腔。
- 身份、寒暄或对话中已有信息，可以直接完整回答。
- 涉及新事实、需要查证、需要工具或最新数据时，不得凭模型参数记忆直接作答；必须用自己的话自然说明要先核实，由后续处理带回事实结果。
- 用户要求判断、建议、选择、比较或评价时，也不得在首条回复里直接给倾向、结论、优劣或支撑这些结论的新事实；必须自然说明要先分析核实，由后续处理带回结论。近期对话里出现过问题，不代表其中已经有可靠答案。
- 用户可见文案中绝不谈论内部系统、路由、模型分层或实现细节。
- 只输出一个 JSON 对象，不要 Markdown 围栏，不要额外文字。
- 除 action/text 外不要添加任何字段。`;

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
export function parseResponderOutput(text) {
  if (typeof text !== "string" || !text.trim()) throw new Error("empty responder output");
  const trimmed = text.trim();
  // Reject fenced/mixed output — foreground contract is a single bare JSON object.
  if (trimmed.startsWith("```") || /```/.test(trimmed)) {
    throw new Error("fenced or mixed responder output");
  }
  const j = JSON.parse(trimmed);
  if (!j || typeof j !== "object" || Array.isArray(j)) throw new Error("bad responder schema");
  const allowed = new Set(["action", "text"]);
  if (Object.keys(j).some((key) => !allowed.has(key))) throw new Error("unexpected responder field");
  if (!["reply", "no_reply"].includes(j.action)) throw new Error("unsupported responder action");
  if (j.action === "no_reply") {
    if (Object.keys(j).length !== 1) throw new Error("no_reply must only have action");
    return { action: "no_reply" };
  }
  if (typeof j.text !== "string" || !j.text.trim()) throw new Error("reply requires non-empty text");
  if (j.text.length > REPLY_MAX) throw new Error("reply text too long");
  return { action: "reply", text: j.text.trim() };
}

/** Strict parser for stage-aware progress handoff output. */
export function parseProgressHandoffOutput(text) {
  if (typeof text !== "string" || !text.trim()) throw new Error("empty progress handoff output");
  const trimmed = text.trim();
  if (trimmed.startsWith("```") || /```/.test(trimmed)) {
    throw new Error("fenced or mixed progress handoff output");
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
export function createResponder({ caller, soul = "", onEvent = null } = {}) {
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
      verdict = parseResponderOutput(out.text);
    } catch {
      verdict = isAddressedOrPrivate(mode)
        ? { action: "reply", text: SAFE_ADDRESSED_FALLBACK }
        : { action: "no_reply" };
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
      verdict = { action: "reply", text: SAFE_ADDRESSED_FALLBACK };
    }
    if (verdict.action === "reply" && !verdict.text.trim()) {
      verdict = { action: "reply", text: SAFE_ADDRESSED_FALLBACK };
    }

    return {
      ...verdict,
      meta: {
        provider: out?.model ?? null,
        usage: out?.usage ?? null,
        sessionKey,
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

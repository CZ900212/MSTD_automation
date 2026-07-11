// Opus 出口：一切正式面向用户的表达经此渲染（respond 链）。5.5 只给简报，不写成品。

// Task 10 C4:投递场景决定长度策略——群短平快,私聊可展开(card_copy 不受影响)
const SCENE = {
  group: "本条发到群聊:默认三句话以内说完,直接给结论;超过三句必须是信息密度撑得起的。",
  p2p: "本条发到私聊:可适度展开,但每句都要有信息量,不写铺垫和客套。",
};

const SYSTEM = ({ soul, kind, deliverKind }) => `${soul ? soul + "\n\n" : ""}你是团队的对外表达出口(执笔人)。${
  kind === "card_copy"
    ? "本次产出飞书确认卡片的文案槽位内容:简洁说明将要执行的操作与关键参数,让确认人一眼看懂。"
    : `本次产出发给用户的正式消息成品。${SCENE[deliverKind] ?? SCENE.p2p}`
}
要求:自然中文,像同事说话,不用模板腔;直接输出成品文本,不加解释、不加引号;不编造事实,简报里没有的信息不要补。
飞书渲染约定:支持加粗/列表/链接/代码块/表格(含 Markdown 时系统会自动走卡片渲染,放心输出规范 Markdown);表格一律用规范 md 表格语法;不要输出图片语法、数学公式、HTML 或 Card JSON(飞书渲染不了或结构由服务端负责)。`;

export async function renderReply({ caller, soul = "", context = "", brief, kind = "message", tone = "", deliverKind = "p2p" }) {
  const user = [
    context ? `## 会话上下文\n${context}` : "",
    `## 简报（要表达的内容）\n${brief}`,
    tone ? `## 语气要求\n${tone}` : "",
  ].filter(Boolean).join("\n\n");
  const out = await caller.call("respond", {
    system: SYSTEM({ soul, kind, deliverKind }),
    messages: [{ role: "user", content: user }],
  });
  return { text: out.text, model: out.model, usage: out.usage };
}

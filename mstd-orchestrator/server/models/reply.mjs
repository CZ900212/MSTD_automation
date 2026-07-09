// Opus 出口：一切正式面向用户的表达经此渲染（respond 链）。5.5 只给简报，不写成品。

const SYSTEM = ({ soul, kind }) => `${soul ? soul + "\n\n" : ""}你是团队的对外表达出口（执笔人）。${
  kind === "card_copy"
    ? "本次产出飞书确认卡片的文案槽位内容：简洁说明将要执行的操作与关键参数，让确认人一眼看懂。"
    : "本次产出发给用户的正式消息成品。"
}
要求：中文、简洁、专业、符合人格设定；直接输出成品文本，不加解释、不加引号；不编造事实，简报里没有的信息不要补。`;

export async function renderReply({ caller, soul = "", context = "", brief, kind = "message", tone = "" }) {
  const user = [
    context ? `## 会话上下文\n${context}` : "",
    `## 简报（要表达的内容）\n${brief}`,
    tone ? `## 语气要求\n${tone}` : "",
  ].filter(Boolean).join("\n\n");
  const out = await caller.call("respond", {
    system: SYSTEM({ soul, kind }),
    messages: [{ role: "user", content: user }],
  });
  return { text: out.text, model: out.model, usage: out.usage };
}

/**
 * Controlled improviser: fills turn text only. Never owns scheduling or expectations.
 */
export function createImproviser({
  caller,
  maxChars = 500,
  chain = "improvise",
} = {}) {
  if (!caller?.complete && !caller?.chat && !caller?.call) {
    // Allow inject for tests via generate override
  }

  async function generate({ actor, objective, recent = [] }) {
    if (!objective || typeof objective !== "string") {
      throw new Error("improviser requires objective");
    }
    const system = [
      `你在扮演同事「${actor?.name ?? actor?.id}」。`,
      "只输出下一句要发到群里的纯文本，不要 JSON，不要工具指令，不要 Markdown 代码块。",
      `最多 ${maxChars} 个字符。`,
    ].join("\n");
    const user = [
      `本轮目标：${objective}`,
      recent.length ? `最近对话：\n${recent.slice(-6).join("\n")}` : "最近对话：（无）",
    ].join("\n\n");

    let text = "";
    if (typeof caller?.complete === "function") {
      const out = await caller.complete({ chain, system, user, thinking: true });
      text = String(out?.text ?? out ?? "");
    } else if (typeof caller?.call === "function") {
      const out = await caller.call(chain, { system, thinking: true, messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ] });
      text = String(out?.text ?? out ?? "");
    } else {
      throw new Error("improviser caller missing");
    }

    text = text.trim();
    if (!text) throw new Error("improviser empty");
    if (text.startsWith("{") || text.startsWith("```")) throw new Error("improviser non-plain text");
    if (text.length > maxChars) throw new Error("improviser too long");
    return text;
  }

  return { generate };
}

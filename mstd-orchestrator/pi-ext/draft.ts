/**
 * Pi 扩展：draft_zh 工具 —— 「与用户交互」的唯一出口。
 * 定型分工（2026-07-09）：主脑 = GPT-5.5（编排/工具循环），但**所有面向人的正式中文表达**
 * （发给用户/主持人的消息、飞书卡片文案、周报/通知、纪要摘要、派活话术）都必须经此工具，
 * 由 Claude Opus 4.6（CZ 网关，纯文本执笔）产出。主脑不直接对用户写中文成品，只负责调它。
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

const URL = "https://api.cz900212.com/v1/chat/completions";
const MODEL = "claude-opus-4-6";
const SYS = "你是资深中文商务写作助手，服务于一家供应链公司的内部自动管理系统。输出简洁、专业、准确，不啰嗦，不编造事实。除非要求，否则直接给成品文本，不加解释。";

export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: "draft_zh",
    label: "Draft(Opus)",
    description:
      "【与用户交互的唯一出口】用 Claude Opus 4.6 执笔面向人的正式中文成品：" +
      "发给用户/主持人的消息、飞书卡片文案、周报/通知、纪要摘要、派活话术。" +
      "你(GPT 主脑)负责编排与判断，但凡要给人看的中文文字，都必须调此工具由 Opus 落笔，不要自己直接写成品。" +
      "把目标/体裁/受众用 instruction 说清，原始素材（逐字稿、抽取结果等）放 context。返回成品文本。",
    parameters: Type.Object({
      instruction: Type.String({ description: "要写什么（目标、体裁、受众、字数/风格要求）" }),
      context: Type.Optional(Type.String({ description: "原始素材/数据（逐字稿、线索、抽取结果等）" })),
      max_tokens: Type.Optional(Type.Number({ description: "最大输出 token，默认 2000" })),
    }),

    async execute(_id, params, signal, _onUpdate, _ctx) {
      const key = process.env.CZ_CLAUDE_KEY;
      if (!key) return { content: [{ type: "text", text: "错误：未设置 CZ_CLAUDE_KEY" }], details: { error: "no key" } };
      const userMsg = params.context ? `${params.instruction}\n\n【素材】\n${params.context}` : params.instruction;
      try {
        const resp = await fetch(URL, {
          method: "POST",
          signal,
          headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
          body: JSON.stringify({
            model: MODEL,
            messages: [
              { role: "system", content: SYS },
              { role: "user", content: userMsg },
            ],
            max_tokens: params.max_tokens ?? 2000,
          }),
        });
        if (!resp.ok) {
          const t = await resp.text();
          return { content: [{ type: "text", text: `opus 调用失败 HTTP ${resp.status}: ${t.slice(0, 300)}` }], details: { status: resp.status } };
        }
        const data = await resp.json();
        const text = data?.choices?.[0]?.message?.content ?? "(opus 空返回)";
        return { content: [{ type: "text", text }], details: { model: MODEL, usage: data?.usage } };
      } catch (e) {
        return { content: [{ type: "text", text: `opus 调用异常: ${e instanceof Error ? e.message : String(e)}` }], details: { error: String(e) } };
      }
    },
  });
}

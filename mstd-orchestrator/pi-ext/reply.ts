/**
 * Pi 扩展：reply 工具 —— 5.5 中枢的唯一出站通道（取代 draft_zh 的常驻 agent 版）。
 * 薄壳设计：本工具不落笔、不发送，只把简报回传 daemon（内部 HTTP），
 * 由 daemon 用 Opus(respond 链) 渲染终稿并经 outbound 发出/填卡片槽位，结果回给 5.5。
 * 整回合不调用 = 自然静默（daemon 永不外发 5.5 裸文本）。
 * 会话归属经 env 注入：MSTD_INTERNAL_URL / MSTD_INTERNAL_TOKEN / MSTD_SESSION_KEY。
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: "reply",
    label: "Reply(Opus 出口)",
    description:
      "【你的唯一出站通道】把要向用户表达的内容以简报形式提交，由出口模型(Opus)执笔成稿并发送。" +
      "kind=message 发正式消息；kind=card_copy 供确认卡片文案槽位。" +
      "可多次调用（如中途进度播报 + 最终结论）。你不调用它，用户就收不到任何内容（静默）。" +
      "brief 写清要表达什么（事实、结论、数据）；不要自己写成品文案。",
    parameters: Type.Object({
      kind: Type.Union([Type.Literal("message"), Type.Literal("card_copy")], { description: "message=发消息 | card_copy=卡片文案" }),
      brief: Type.String({ description: "要表达的内容简报（事实/结论/数据，非成品）" }),
      tone: Type.Optional(Type.String({ description: "语气要求（可选）" })),
      target: Type.Optional(Type.String({ description: "投递目标覆盖（可选，默认当前会话）" })),
    }),

    async execute(_id, params, signal) {
      const base = process.env.MSTD_INTERNAL_URL;
      const token = process.env.MSTD_INTERNAL_TOKEN;
      const sessionKey = process.env.MSTD_SESSION_KEY;
      if (!base || !token || !sessionKey) {
        return { content: [{ type: "text", text: "错误：内部通道未配置（MSTD_INTERNAL_URL/TOKEN/SESSION_KEY）" }], details: { error: "no internal channel" } };
      }
      try {
        const resp = await fetch(`${base}/internal/reply`, {
          method: "POST",
          signal,
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
          body: JSON.stringify({ session_key: sessionKey, kind: params.kind, brief: params.brief, tone: params.tone, target: params.target }),
        });
        const data = await resp.json();
        if (!resp.ok || !data.ok) {
          return { content: [{ type: "text", text: `reply 失败: ${data.error ?? resp.status}` }], details: data };
        }
        return {
          content: [{ type: "text", text: `已${params.kind === "card_copy" ? "生成卡片文案" : "发送"}：${String(data.text ?? "").slice(0, 500)}` }],
          details: { messageId: data.message_id ?? null },
        };
      } catch (e) {
        return { content: [{ type: "text", text: `reply 异常: ${e instanceof Error ? e.message : String(e)}` }], details: { error: String(e) } };
      }
    },
  });
}

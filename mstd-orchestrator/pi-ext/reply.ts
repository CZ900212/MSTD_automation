/**
 * Pi 扩展：reply 工具 —— reasoner 向 responder 提交事实与决定的唯一通道。
 * 薄壳设计：本工具不落笔、不发送，只把简报回传 daemon（内部 HTTP），
 * 由 daemon 用 responder 渲染终稿并经 outbound 发出/填卡片槽位。
 * 整回合不调用 = 自然静默（daemon 永不外发 reasoner 裸文本）。
 * 会话归属经 env 注入：MSTD_INTERNAL_URL / MSTD_INTERNAL_TOKEN / MSTD_SESSION_KEY。
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { createTurnContextReader } from "./turn-context.ts";

export default function (pi: ExtensionAPI) {
  const currentTurnContext = createTurnContextReader(pi);
  pi.registerTool({
    name: "reply",
    label: "Reply(提交给 responder)",
    description:
      "【向 responder 提交事实与决定】把要向用户表达的内容以简报形式提交，由 responder 执笔成稿并发送。" +
      "你不是用户可见出口：禁止假设你的 finalText 会直达用户。" +
      "kind=message 发消息；kind=card_copy 供确认卡片文案槽位。" +
      "stage=progress 仅播报进度且不完成回合；stage=final 发送最终答复。" +
      "如果 progress 简报已经包含答案、结论、建议或执行/失败结果，responder 会在发送前自动按 final 收口。" +
      "可多次调用（如中途 progress + 最终 final）。你不调用 final，daemon 会用 responder 安全收口。" +
      "brief 写清事实、结论、数据与决定；不要自己写成品文案。",
    parameters: Type.Object({
      kind: Type.Union([Type.Literal("message"), Type.Literal("card_copy")], { description: "message=发消息 | card_copy=卡片文案" }),
      stage: Type.Union([Type.Literal("progress"), Type.Literal("final")], { description: "progress=非终态进度 | final=最终答复；card_copy 也必须显式选择" }),
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
      const turnContext = currentTurnContext();
      if (!turnContext) {
        return { content: [{ type: "text", text: "reply 失败: 当前 Pi 回合没有 daemon turn context" }], details: { error: "no turn context" } };
      }
      try {
        const resp = await fetch(`${base}/internal/reply`, {
          method: "POST",
          signal,
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
          body: JSON.stringify({
            session_key: sessionKey,
            turn_id: turnContext.turnId,
            turn_lease: turnContext.lease,
            kind: params.kind,
            stage: params.stage,
            brief: params.brief,
            tone: params.tone,
            target: params.target,
          }),
        });
        const data = await resp.json();
        if (!resp.ok || !data.ok) {
          const errText = typeof data.error === "string" ? data.error : JSON.stringify(data.error ?? resp.status);
          return { content: [{ type: "text", text: `reply 失败: ${errText}` }], details: data };
        }
        return {
          content: [{
            type: "text",
            text: params.kind === "card_copy"
              ? `已生成卡片文案：${String(data.text ?? "").slice(0, 500)}`
              : `已发送（声明阶段=${data.declared_stage ?? params.stage}，有效阶段=${data.effective_stage ?? params.stage}）：${String(data.text ?? "").slice(0, 500)}`,
          }],
          details: {
            messageId: data.message_id ?? null,
            declaredStage: data.declared_stage ?? params.stage,
            effectiveStage: data.effective_stage ?? params.stage,
            stageCorrected: data.stage_corrected === true,
          },
        };
      } catch (e) {
        if (signal?.aborted) throw e; // 回合被取消时如实以 abort 传播,不伪造成"已完成的错误结果"(与 draft.ts 同则)
        return { content: [{ type: "text", text: `reply 异常: ${e instanceof Error ? e.message : String(e)}` }], details: { error: String(e) } };
      }
    },
  });
}

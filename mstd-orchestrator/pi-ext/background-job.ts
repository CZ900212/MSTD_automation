/**
 * Pi 扩展：spawn_background_job —— 5.5 把重任务委托为后台 job，本回合立即可结束。
 * job 完成后结果会作为事件回注会话，届时自然播报；不要在本回合等待它。
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { createTurnContextReader } from "./turn-context.ts";

export default function (pi: ExtensionAPI) {
  const currentTurnContext = createTurnContextReader(pi);
  pi.registerTool({
    name: "spawn_background_job",
    label: "BackgroundJob",
    description:
      "把重任务（深度检索、批量处理、长耗时分析）注册为后台 job 并立即返回 job_id。" +
      "适用：预计超过 1 分钟的工作。job 完成后结果会自动回注本会话，你届时再播报。" +
      "注册后本回合应尽快收尾（可用 reply 告知用户'我去办，稍后同步'）。",
    parameters: Type.Object({
      kind: Type.String({ description: "任务类型短语，如 research / batch_write / analysis" }),
      brief: Type.String({ description: "任务简报：目标、范围、期望产出" }),
      params: Type.Optional(Type.Record(Type.String(), Type.Any(), { description: "结构化参数（可选）" })),
    }),

    async execute(_id, params, signal) {
      const base = process.env.MSTD_INTERNAL_URL;
      const token = process.env.MSTD_INTERNAL_TOKEN;
      const sessionKey = process.env.MSTD_SESSION_KEY;
      if (!base || !token || !sessionKey) {
        return { content: [{ type: "text", text: "错误：内部通道未配置" }], details: { error: "no internal channel" } };
      }
      const turnContext = currentTurnContext();
      if (!turnContext) {
        return { content: [{ type: "text", text: "注册失败: 当前 Pi 回合没有 daemon turn context" }], details: { error: "no turn context" } };
      }
      try {
        const resp = await fetch(`${base}/internal/background`, {
          method: "POST",
          signal,
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
          body: JSON.stringify({
            session_key: sessionKey,
            turn_id: turnContext.turnId,
            turn_lease: turnContext.lease,
            ...params,
          }),
        });
        const data = await resp.json();
        if (!resp.ok || !data.ok) return { content: [{ type: "text", text: `注册失败: ${data.error ?? resp.status}` }], details: data };
        return { content: [{ type: "text", text: `后台 job 已注册: ${data.job_id}，完成后结果会回注本会话。` }], details: data };
      } catch (e) {
        return { content: [{ type: "text", text: `注册异常: ${e instanceof Error ? e.message : String(e)}` }], details: { error: String(e) } };
      }
    },
  });
}

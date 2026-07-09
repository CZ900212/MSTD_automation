/**
 * Pi 扩展：propose_actions —— 5.5 提出写意图的唯一入口（薄壳）。
 * 你只提意图；动作形状/hash/token/卡片全部由服务端定，发确认卡给发起人，确认后才真写。
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

const Intent = Type.Object({
  kind: Type.Union([
    Type.Literal("create_task"),
    Type.Literal("send_dm"),
    Type.Literal("create_event"),
    Type.Literal("send_group_msg"),
  ]),
  payload: Type.Record(Type.String(), Type.Any(), {
    description:
      "create_task:{title,description?,due_date?,assignee_open_id?} | send_dm:{to_open_id,card_ref} | " +
      "create_event:{summary,start_time(ISO),end_time(ISO),attendee_open_ids[]} | send_group_msg:{chat_id,card_ref}",
  }),
});

export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: "propose_actions",
    label: "ProposeActions",
    description:
      "【写操作唯一入口】提出一批写操作意图（建任务/发私信/建日程/发群消息）。" +
      "服务端会规范化并发确认卡片给发起人，用户确认后才执行；执行结果会回注会话。" +
      "关键参数（负责人 open_id、时间）不确定时可留空由确认人在卡片上补选，或先向用户问清。" +
      "绝不要试图绕过本工具直接执行写操作。",
    parameters: Type.Object({
      title: Type.String({ description: "这批操作的一句话标题（确认卡标题）" }),
      intents: Type.Array(Intent, { minItems: 1, maxItems: 10 }),
    }),

    async execute(_id, params, signal) {
      const base = process.env.MSTD_INTERNAL_URL;
      const token = process.env.MSTD_INTERNAL_TOKEN;
      const sessionKey = process.env.MSTD_SESSION_KEY;
      if (!base || !token || !sessionKey) {
        return { content: [{ type: "text", text: "错误：内部通道未配置" }], details: { error: "no internal channel" } };
      }
      try {
        const resp = await fetch(`${base}/internal/propose-actions`, {
          method: "POST",
          signal,
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
          body: JSON.stringify({ session_key: sessionKey, ...params }),
        });
        const data = await resp.json();
        if (!resp.ok || !data.ok) {
          return { content: [{ type: "text", text: `意图未通过: ${data.error ?? resp.status}。请修正参数或向用户问清，不要猜。` }], details: data };
        }
        return { content: [{ type: "text", text: `确认卡已发出（job ${data.job_id}），等用户确认后执行；结果会回注会话，本回合不必等待。` }], details: data };
      } catch (e) {
        return { content: [{ type: "text", text: `提交异常: ${e instanceof Error ? e.message : String(e)}` }], details: { error: String(e) } };
      }
    },
  });
}

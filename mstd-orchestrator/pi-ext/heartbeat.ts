/**
 * Pi 扩展：heartbeat_update —— 5.5 维护 HEARTBEAT 待办清单（"明天提醒我X"类零散主动行为）。
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: "heartbeat_update",
    label: "Heartbeat",
    description:
      "维护心跳待办清单。用户说'X点提醒我/明天记得Y'之类 → add 一条（due_iso 填 ISO 时间，deliver_to 填当前会话键）。" +
      "到期后心跳回合会自动执行。remove 用于取消（match 填能唯一定位该行的子串）。",
    parameters: Type.Object({
      action: Type.Union([Type.Literal("add"), Type.Literal("remove")]),
      due_iso: Type.Optional(Type.String({ description: "add：到期时间 ISO 8601（含时区）" })),
      text: Type.Optional(Type.String({ description: "add：到期要做的事" })),
      deliver_to: Type.Optional(Type.String({ description: "add：投递目标（默认当前会话）" })),
      match: Type.Optional(Type.String({ description: "remove：唯一定位子串" })),
    }),

    async execute(_id, params, signal) {
      const base = process.env.MSTD_INTERNAL_URL;
      const token = process.env.MSTD_INTERNAL_TOKEN;
      const sessionKey = process.env.MSTD_SESSION_KEY;
      if (!base || !token || !sessionKey) {
        return { content: [{ type: "text", text: "错误：内部通道未配置" }], details: { error: "no internal channel" } };
      }
      try {
        const resp = await fetch(`${base}/internal/heartbeat`, {
          method: "POST",
          signal,
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
          body: JSON.stringify({ session_key: sessionKey, ...params }),
        });
        const data = await resp.json();
        if (!resp.ok || !data.ok) return { content: [{ type: "text", text: `heartbeat 失败: ${data.error ?? resp.status}` }], details: data };
        return { content: [{ type: "text", text: params.action === "add" ? "已加入心跳清单，到期自动执行。" : "已从清单移除。" }], details: data };
      } catch (e) {
        return { content: [{ type: "text", text: `heartbeat 异常: ${e instanceof Error ? e.message : String(e)}` }], details: { error: String(e) } };
      }
    },
  });
}

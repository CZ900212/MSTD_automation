/**
 * Pi 扩展：heartbeat_update —— 维护「当前会话」的心跳提醒（C0.4 owner-bound 队列版）。
 * 本工具只能管理当前会话的提醒;跨会话提醒请用 propose_actions 的 schedule_reminder（需用户确认）。
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { formatDueAtBeijing } from "../server/time/beijing-iso.mjs";
import { postInternal } from "./internal-channel.ts";

export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: "heartbeat_update",
    label: "Heartbeat",
    description:
      "维护当前会话的心跳提醒。用户说'X点提醒我/明天记得Y'之类 → add 一条（due_iso 必须带时区）;" +
      "list 查看本会话待办;remove 按 item_id 取消（先 list 拿 id）。" +
      "注意：本工具只能管理当前会话的提醒,跨会话请用 propose_actions 的 schedule_reminder（需用户确认）。",
    parameters: Type.Object({
      action: Type.Union([Type.Literal("add"), Type.Literal("list"), Type.Literal("remove")]),
      due_iso: Type.Optional(Type.String({ description: "add：到期时间 ISO 8601（必须含时区,如 2026-07-12T09:00:00+08:00）" })),
      text: Type.Optional(Type.String({ description: "add：到期要提醒的内容" })),
      item_id: Type.Optional(Type.String({ description: "remove：list 返回的条目 id" })),
    }),

    async execute(_id, params, signal) {
      try {
        const r = await postInternal("/internal/heartbeat", {
          action: params.action,
          due_iso: params.due_iso,
          text: params.text,
          item_id: params.item_id,
        }, { signal });
        if (!r.ok) {
          return {
            content: [{ type: "text", text: r.status === 0 ? `错误：${r.errorText}` : `heartbeat 失败: ${r.errorText}` }],
            details: r.data,
          };
        }
        let text: string;
        if (params.action === "add") {
          text = `已加入本会话提醒（item_id: ${r.data.item_id}）,到期自动投递。`;
        } else if (params.action === "list") {
          const items = (r.data.items ?? []) as Array<{ id: string; due_at: number; text: string }>;
          text = items.length
            ? items.map((i) => `- ${formatDueAtBeijing(i.due_at)} ${i.text}（取消用 item_id=${i.id}）`).join("\n")
            : "当前会话没有待办提醒。";
        } else {
          text = "已取消该提醒。";
        }
        return { content: [{ type: "text", text }], details: r.data };
      } catch (e) {
        if (signal?.aborted) throw e;
        return { content: [{ type: "text", text: `heartbeat 异常: ${e instanceof Error ? e.message : String(e)}` }], details: { error: String(e) } };
      }
    },
  });
}

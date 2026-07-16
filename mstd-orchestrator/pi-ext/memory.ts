/**
 * Pi 扩展：memory 工具 —— 5.5 中枢的全局记忆读写（薄壳，经内部通道回传 daemon）。
 * 层级与越权控制在 daemon 侧（server/memory/tool.mjs），本壳只透传。
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: "memory",
    label: "Memory",
    description:
      "会话记忆读写。layer: org=公司共享事实(只读) | group=本群记忆(id=chat_id) | user=本人画像(id=open_id，仅私聊) | soul=人格(只读)。journal 是受控审计层，不向模型开放。" +
      "action: add=追加条目 | replace=替换(old_text 唯一命中) | remove=删除(old_text 唯一命中) | read=读取。" +
      "值得长期记住的事实/偏好/决定要及时 add；过时信息用 replace/remove 维护。条目会自动带来源与时间戳。",
    parameters: Type.Object({
      action: Type.Union([Type.Literal("add"), Type.Literal("replace"), Type.Literal("remove"), Type.Literal("read")]),
      layer: Type.Union([Type.Literal("org"), Type.Literal("group"), Type.Literal("user"), Type.Literal("soul")]),
      id: Type.Optional(Type.String({ description: "group=chat_id / user=open_id；org/soul 不需要" })),
      entry: Type.Optional(Type.String({ description: "add/replace 的新条目内容" })),
      old_text: Type.Optional(Type.String({ description: "replace/remove 的定位子串（须唯一命中）" })),
    }),

    async execute(_id, params, signal) {
      const base = process.env.MSTD_INTERNAL_URL;
      const token = process.env.MSTD_INTERNAL_TOKEN;
      const sessionKey = process.env.MSTD_SESSION_KEY;
      if (!base || !token || !sessionKey) {
        return { content: [{ type: "text", text: "错误：内部通道未配置" }], details: { error: "no internal channel" } };
      }
      try {
        const resp = await fetch(`${base}/internal/memory`, {
          method: "POST",
          signal,
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
          body: JSON.stringify({ session_key: sessionKey, ...params }),
        });
        const data = await resp.json();
        if (!resp.ok || !data.ok) return { content: [{ type: "text", text: `memory 失败: ${data.error ?? resp.status}` }], details: data };
        return { content: [{ type: "text", text: params.action === "read" ? (data.content || "（空）") : "已写入" }], details: data };
      } catch (e) {
        if (signal?.aborted) throw e; // 与 draft.ts 同则:abort 如实传播,不伪造错误结果
        return { content: [{ type: "text", text: `memory 异常: ${e instanceof Error ? e.message : String(e)}` }], details: { error: String(e) } };
      }
    },
  });
}

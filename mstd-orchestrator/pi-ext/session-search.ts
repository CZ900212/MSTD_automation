/**
 * Pi 扩展：session_search 工具 —— 跨会话历史检索（薄壳，权限过滤在 daemon 侧）。
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: "session_search",
    label: "SessionSearch",
    description:
      "按关键词检索历史会话消息（当前会话可见范围内：群会话只搜本群、私聊只搜本人）。" +
      "用于回忆之前聊过什么、查某件事的上下文。返回命中消息及时间。",
    parameters: Type.Object({
      query: Type.String({ description: "检索关键词（中文可用）" }),
      limit: Type.Optional(Type.Number({ description: "最多返回条数，默认 10" })),
    }),

    async execute(_id, params, signal) {
      const base = process.env.MSTD_INTERNAL_URL;
      const token = process.env.MSTD_INTERNAL_TOKEN;
      const sessionKey = process.env.MSTD_SESSION_KEY;
      if (!base || !token || !sessionKey) {
        return { content: [{ type: "text", text: "错误：内部通道未配置" }], details: { error: "no internal channel" } };
      }
      try {
        const resp = await fetch(`${base}/internal/session-search`, {
          method: "POST",
          signal,
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
          body: JSON.stringify({ session_key: sessionKey, ...params }),
        });
        const data = await resp.json();
        if (!resp.ok || !data.ok) return { content: [{ type: "text", text: `检索失败: ${data.error ?? resp.status}` }], details: data };
        const lines = (data.hits ?? []).map((h: any) => `[${new Date(h.ts).toISOString()}] ${h.sessionKey}: ${h.content}`);
        return { content: [{ type: "text", text: lines.length ? lines.join("\n") : "（无命中）" }], details: data };
      } catch (e) {
        if (signal?.aborted) throw e; // 与 draft.ts 同则:abort 如实传播,不伪造错误结果
        return { content: [{ type: "text", text: `检索异常: ${e instanceof Error ? e.message : String(e)}` }], details: { error: String(e) } };
      }
    },
  });
}

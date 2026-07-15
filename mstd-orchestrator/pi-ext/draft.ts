// Legacy meeting-job card-copy tool. 直接走服务端共享的 respond 链（caller.mjs CHAINS.respond），
// 模型 id / base URL / 降级顺序单一来源——中枢换脑时此处零改动。
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { createModelCaller } from "../server/models/caller.mjs";

const SYS = "你是团队内部自动管理系统的中文表达出口。输出简洁、准确、自然，不编造事实。直接给成品文本，不加解释。";

export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: "draft_zh",
    label: "Draft(respond)",
    description: "用当前 respond 链生成给审批人看的简洁中文卡片文案。只负责表达，不执行写操作。",
    parameters: Type.Object({
      instruction: Type.String({ description: "要写什么（目标、受众、字数与风格）" }),
      context: Type.Optional(Type.String({ description: "原始素材或抽取结果" })),
      max_tokens: Type.Optional(Type.Number({ description: "最大输出 token，默认 2000" })),
    }),

    async execute(_id, params, signal, _onUpdate, _ctx) {
      if (!process.env.DEEPSEEK_KEY && !process.env.CZ_GPT_KEY) {
        const missing = "v4-pro: missing key | gpt-5.6-sol: missing key";
        return { content: [{ type: "text", text: `respond 链调用失败: ${missing}` }], details: { error: missing } };
      }
      const userMsg = params.context ? `${params.instruction}\n\n【素材】\n${params.context}` : params.instruction;
      // retries: 1 —— 保持旧语义：每 provider 单次尝试，失败立刻降级到下一个。
      const caller = createModelCaller({
        retries: 1,
        maxTokens: params.max_tokens ?? 2000,
        fetchFn: (url: string, init: RequestInit) => fetch(url, {
          ...init,
          signal: signal && init?.signal ? AbortSignal.any([init.signal, signal]) : (signal ?? init?.signal),
        }),
      });
      try {
        const out = await caller.call("respond", { system: SYS, messages: [{ role: "user", content: userMsg }] });
        return { content: [{ type: "text", text: out.text }], details: { model: out.model, usage: out.usage } };
      } catch (e) {
        if (signal?.aborted) throw e;
        const msg = e instanceof Error ? e.message : String(e);
        return { content: [{ type: "text", text: `respond 链调用失败: ${msg}` }], details: { error: msg } };
      }
    },
  });
}

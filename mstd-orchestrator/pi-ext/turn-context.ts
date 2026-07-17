// 为什么走带内协议（prompt 首行传 turn lease）而不是环境变量或 RPC 元数据：
//   - lease 是 per-turn 的，常驻 Pi 进程跨多个 turn 复用，per-process env 装不下它；
//   - Pi RPC runJob 没有 per-job 元数据通道，prompt 是唯一随 turn 到达的载体。
// 因此 daemon（server/models/brain.mjs 的 prompt 模板）把 `MSTD_TURN_CONTEXT_V1 <turnId> <lease>`
// 写进 prompt 首行，本扩展在 before_agent_start 解析暂存、并靠 context 钩子每轮从历史里剥除，
// 防止 lease 泄入模型上下文。三处正则必须同步演进：brain.mjs 模板、parseTurnContext、
// stripTurnContext——改任何一处格式都要同批改齐另外两处。
// ⚠️ 此模式是无奈之举，不得效仿到其他凭证：任何新秘密都不许再走 prompt 带内传递。

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

type ContextMessage = { role: string; content?: unknown };
type TextPart = { type: string; text?: string; [key: string]: unknown };

// Pi 对每个 -e 条目使用独立 Jiti 模块图，因此扩展间不能用模块单例传状态。
// ExtensionAPI.events 是同一 Pi runtime 内所有扩展共享的正式通信边界：上下文扩展
// 发布 turn lifecycle，reply/propose_actions 各自在自己的闭包内订阅并保存当前值。
// 这样既跨得过独立模块图，也不会像 globalThis 一样把多个 runtime 串在一起。
export const TURN_CONTEXT_CHANNEL = "mstd:turn-context:v1";

export type TurnContext = Readonly<{
  turnId: string;
  lease: string;
}>;

export function parseTurnContext(prompt: string): TurnContext | null {
  const firstLine = String(prompt ?? "").split("\n", 1)[0];
  const match = /^MSTD_TURN_CONTEXT_V1 ([A-Za-z0-9._:-]{1,200}) ([A-Za-z0-9-]{1,200})$/.exec(firstLine);
  if (!match) return null;
  return Object.freeze({ turnId: match[1], lease: match[2] });
}

export function stripTurnContext(messages: ContextMessage[]): ContextMessage[] {
  return messages.map((message) => {
    if (message.role !== "user" || !Array.isArray(message.content)) return message;
    let changed = false;
    const content = (message.content as TextPart[]).map((part: TextPart) => {
      if (part.type !== "text" || typeof part.text !== "string") return part;
      // context 事件每轮 round-trip 都拿到原始历史（标记不会因上一轮已剥离而消失），
      // 不能做"剥过一次就跳过"的状态化短路——用 startsWith 廉价预筛代替全量正则。
      if (!part.text.startsWith("MSTD_TURN_CONTEXT_V1 ")) return part;
      const stripped = part.text.replace(
        /^MSTD_TURN_CONTEXT_V1 [A-Za-z0-9._:-]{1,200} [A-Za-z0-9-]{1,200}\n/,
        "",
      );
      if (stripped !== part.text) changed = true;
      return stripped === part.text ? part : { ...part, text: stripped };
    });
    return changed ? { ...message, content } : message;
  });
}

export function createTurnContextReader(pi: Pick<ExtensionAPI, "events">): () => TurnContext | null {
  let active: TurnContext | null = null;
  pi.events.on(TURN_CONTEXT_CHANNEL, (value) => {
    active = value as TurnContext | null;
  });
  return () => active;
}

export default function (pi: ExtensionAPI) {
  pi.on("before_agent_start", async (event) => {
    const parsed = parseTurnContext(event.prompt);
    // steer/continuation prompts have no daemon marker and must not unbind the
    // still-running resident turn; agent_end or server-side close revokes it.
    if (parsed) pi.events.emit(TURN_CONTEXT_CHANNEL, parsed);
  });

  pi.on("context", async (event) => ({
    messages: stripTurnContext(event.messages) as typeof event.messages,
  }));

  pi.on("agent_end", async () => {
    pi.events.emit(TURN_CONTEXT_CHANNEL, null);
  });
}

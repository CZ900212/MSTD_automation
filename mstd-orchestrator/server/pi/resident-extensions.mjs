// C1:常驻 brain 的 Pi 扩展清单——production source of truth。
// index.mjs 与 e2e-persona 都消费本工厂,不得各自手写列表。
// persona 必须第一(before_agent_start 整体替换系统提示词);job/read-only Pi 不加载本清单。
import { join } from "node:path";

export function buildResidentExtensions(root) {
  return [
    join(root, "pi-ext", "persona.ts"),
    join(root, "pi-ext", "providers.ts"),
    join(root, "pi-ext", "reply.ts"),
    join(root, "pi-ext", "memory.ts"),
    join(root, "pi-ext", "session-search.ts"),
    join(root, "pi-ext", "propose-actions.ts"),
    join(root, "pi-ext", "background-job.ts"),
    join(root, "pi-ext", "heartbeat.ts"),
    join(root, "pi-ext", "lark-read.ts"),
  ];
}

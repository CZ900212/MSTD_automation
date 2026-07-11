// pi-ext/persona.ts
// 常驻人格扩展:加载时读 SOUL 一次(fail-fast),每回合以同一字符串整体替换系统提示词。
import { readFileSync } from "node:fs";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { buildPersonaPrompt } from "./persona-prompt.ts";

// 已知取舍(§5.1 审核记账):dateStr 在 Pi 进程生命周期内冻结——字节稳定吃前缀缓存的
// 规格明选;常驻 Pi 空闲 10min 即回收,仅连续繁忙 >24h 的会话才会日期陈旧。
export function createPersonaHook({
  soulPath,
  readFile = readFileSync,
  now = () => new Date(),
  workspace = process.cwd(),
}: {
  soulPath: string;
  readFile?: (path: string, enc: "utf8") => string;
  now?: () => Date;
  workspace?: string;
}) {
  if (!soulPath) throw new Error("persona: MSTD_SOUL_PATH 未配置");
  const soul = readFile(soulPath, "utf8");                    // 每个 Pi 进程初始化时只读一次
  const dateStr = new Intl.DateTimeFormat("zh-CN", { timeZone: "Asia/Shanghai", dateStyle: "long" }).format(now());
  const prompt = buildPersonaPrompt({ soul, dateStr, workspace });
  return async () => ({ systemPrompt: prompt });
}

export default function (pi: ExtensionAPI) {
  pi.on("before_agent_start", createPersonaHook({ soulPath: process.env.MSTD_SOUL_PATH ?? "" }));
}

/**
 * Pi 扩展：time —— 纯计算、无副作用、不打 daemon。
 * 用途：显式确认/换算某时区的当前时间，或为提醒取精确 ISO（带偏移）。
 * 注意：应答机/推理机的上下文已被动注入"现在"，日常无需调用本工具；
 * 仅在需要非北京时区换算或精确 ISO 定时计算时才用。
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

// pi-ext 经 jiti 独立加载，与 server/ 不共享模块图；北京时间字面量在仓库多处硬编码，此处沿用。
const SHANGHAI_TZ = "Asia/Shanghai";

type TimeInfo = { human: string; iso: string; timezone: string };
type TimeDetails = { iso: string; timezone: string; error?: string };

const HUMAN_FMT_OPTS: Intl.DateTimeFormatOptions = {
  year: "numeric", month: "long", day: "numeric", weekday: "long",
  hour: "2-digit", minute: "2-digit", hour12: false,
};
const ISO_FMT_OPTS: Intl.DateTimeFormatOptions = {
  year: "numeric", month: "2-digit", day: "2-digit",
  hour: "2-digit", minute: "2-digit", second: "2-digit",
  hour12: false, timeZoneName: "longOffset",
};

// 纯函数（供 vitest 直测）：给定时钟与时区，产出人类可读串 + 严格 ISO（带偏移）。
export function computeTimeInfo(
  now: () => Date = () => new Date(),
  timezone: string = SHANGHAI_TZ,
): TimeInfo {
  const d = now();
  const human = new Intl.DateTimeFormat("zh-CN", { timeZone: timezone, ...HUMAN_FMT_OPTS }).format(d);
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-CA", { timeZone: timezone, ...ISO_FMT_OPTS })
      .formatToParts(d)
      .map((p) => [p.type, p.value]),
  );
  const hour = parts.hour === "24" ? "00" : parts.hour; // hour12:false 午夜可能产出 "24"
  // longOffset 形如 "GMT+08:00"；UTC 可能仅 "GMT"，归一为 "+00:00"。
  const off = String(parts.timeZoneName ?? "").replace(/^(GMT|UTC)/, "") || "+00:00";
  const iso = `${parts.year}-${parts.month}-${parts.day}T${hour}:${parts.minute}:${parts.second}${off}`;
  return { human, iso, timezone };
}

export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: "time",
    label: "Time",
    description:
      "取某时区的当前时间（纯计算，无副作用）。上下文里通常已给出北京时间的\"现在\"，" +
      "仅在需要换算到其他时区、或为提醒/日程计算精确 ISO 时才调用。" +
      "返回人类可读时间；details.iso 是带偏移的严格 ISO 8601，可直接用于 schedule_reminder。",
    parameters: Type.Object({
      timezone: Type.Optional(
        Type.String({ description: "IANA 时区名，如 Asia/Shanghai、America/New_York；缺省北京时间" }),
      ),
    }),
    async execute(_id, params) {
      const tz = (params.timezone ?? "").trim() || SHANGHAI_TZ;
      try {
        const info = computeTimeInfo(() => new Date(), tz);
        const details: TimeDetails = { iso: info.iso, timezone: info.timezone };
        return { content: [{ type: "text", text: info.human }], details };
      } catch (e) {
        // 无效时区等 → fail-closed 回退北京时间，并说明。
        const info = computeTimeInfo(() => new Date(), SHANGHAI_TZ);
        const details: TimeDetails = { iso: info.iso, timezone: info.timezone, error: e instanceof Error ? e.message : String(e) };
        return { content: [{ type: "text", text: `时区「${tz}」无法识别，已按北京时间给出：${info.human}` }], details };
      }
    },
  });
}

// 当前时间助手：给小达（应答机/推理机）逐回合注入"现在"，并供 time 工具复用。
// now 可注入以便单测确定性；北京时间为固定 +08:00（无夏令时）。
export const SHANGHAI_TZ = "Asia/Shanghai";

const DATE_FMT = new Intl.DateTimeFormat("zh-CN", {
  timeZone: SHANGHAI_TZ, year: "numeric", month: "long", day: "numeric", weekday: "long",
});
const TIME_FMT = new Intl.DateTimeFormat("zh-CN", {
  timeZone: SHANGHAI_TZ, hour: "2-digit", minute: "2-digit", hour12: false,
});
const ISO_FMT = new Intl.DateTimeFormat("en-CA", {
  timeZone: SHANGHAI_TZ, year: "numeric", month: "2-digit", day: "2-digit",
  hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false,
});

// 人类可读："2026年7月16日星期四 14:32（北京时间）"
export function formatNow(now = () => new Date()) {
  const d = now();
  return `${DATE_FMT.format(d)} ${TIME_FMT.format(d)}（北京时间）`;
}

// 严格 ISO 8601（带 +08:00 偏移），可回喂 strict-iso 校验，供提醒定时计算基准。
export function nowIso(now = () => new Date()) {
  const parts = Object.fromEntries(ISO_FMT.formatToParts(now()).map((p) => [p.type, p.value]));
  // hour12:false 在午夜可能产出 "24"，归一为 "00"（同日）。
  const hour = parts.hour === "24" ? "00" : parts.hour;
  return `${parts.year}-${parts.month}-${parts.day}T${hour}:${parts.minute}:${parts.second}+08:00`;
}

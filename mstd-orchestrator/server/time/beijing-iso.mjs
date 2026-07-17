// 北京时间 ISO 渲染（带 +08:00 偏移）。供 pi-ext list 展示与单测共用。

const SHANGHAI_TZ = "Asia/Shanghai";

/**
 * @param {number} dueAtMs epoch milliseconds
 * @returns {string} e.g. 2026-07-17T09:00:00+08:00
 */
export function formatDueAtBeijing(dueAtMs) {
  const d = new Date(dueAtMs);
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-CA", {
      timeZone: SHANGHAI_TZ,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hour12: false,
      timeZoneName: "longOffset",
    })
      .formatToParts(d)
      .map((p) => [p.type, p.value]),
  );
  const hour = parts.hour === "24" ? "00" : parts.hour;
  const off = String(parts.timeZoneName ?? "").replace(/^(GMT|UTC)/, "") || "+00:00";
  return `${parts.year}-${parts.month}-${parts.day}T${hour}:${parts.minute}:${parts.second}${off}`;
}

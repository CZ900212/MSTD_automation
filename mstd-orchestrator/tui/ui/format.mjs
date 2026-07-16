// 纯格式化助手（时间/时长）。单行文本的截断一律交给 Ink 的 wrap="truncate"
// （它用 string-width 正确处理中日韩宽字符），这里不做手工宽度计算。
const pad2 = (n) => String(n).padStart(2, "0");

export function fmtClock(ts) {
  if (!ts) return "--:--:--";
  const d = new Date(ts);
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
}

// 运行时长：42s / 3:07 / 2h13m
export function fmtElapsed(ms) {
  if (ms == null || !Number.isFinite(ms) || ms < 0) return "-";
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}:${pad2(s % 60)}`;
  return `${Math.floor(s / 3600)}h${pad2(Math.floor((s % 3600) / 60))}m`;
}

// uptime：粗粒度 2h13m / 13m / 42s
export function fmtUptime(ms) {
  if (ms == null || !Number.isFinite(ms) || ms < 0) return "-";
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  return `${Math.floor(s / 3600)}h${Math.floor((s % 3600) / 60)}m`;
}

export function fmtWindow(ms) {
  const m = Math.round(ms / 60000);
  return m >= 60 ? `${Math.round(m / 60)}h` : `${m}m`;
}

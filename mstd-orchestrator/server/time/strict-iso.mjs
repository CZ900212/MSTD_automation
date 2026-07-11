// 严格 ISO 8601（必须带时区）解析：正则拆解 + 真实日历校验 + offset 范围校验,
// 拒绝一切会被 Date.parse 宽松归一化的输入（如 2026-02-30 → 3 月 2 日）。
// 返回 epoch ms;任何不合法输入返回 null（fail-closed,不抛错）。
const ISO_RE = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?(Z|[+-]\d{2}:\d{2})$/;

export function parseStrictIsoWithTimezone(input) {
  if (typeof input !== "string") return null;
  const m = ISO_RE.exec(input);
  if (!m) return null;
  const [, y, mo, d, h, mi, s, frac, off] = m;
  const year = Number(y), month = Number(mo), day = Number(d);
  const hour = Number(h), minute = Number(mi), second = Number(s);

  // 真实日历：月 1-12,日按当月实际天数（含闰年）
  if (month < 1 || month > 12) return null;
  const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
  if (day < 1 || day > daysInMonth) return null;
  if (hour > 23 || minute > 59 || second > 59) return null;

  // offset 范围：±14:00 以内,分钟 0-59
  let offsetMinutes = 0;
  if (off !== "Z") {
    const sign = off[0] === "-" ? -1 : 1;
    const oh = Number(off.slice(1, 3));
    const om = Number(off.slice(4, 6));
    if (om > 59 || oh > 14 || (oh === 14 && om > 0)) return null;
    offsetMinutes = sign * (oh * 60 + om);
  }

  const ms = frac ? Number(frac.padEnd(3, "0")) : 0;
  const utc = Date.UTC(year, month - 1, day, hour, minute, second, ms) - offsetMinutes * 60_000;
  if (!Number.isFinite(utc)) return null;
  // 双保险：与引擎解析交叉验证,防手工计算与语义漂移
  const reparsed = Date.parse(input);
  if (!Number.isFinite(reparsed) || reparsed !== utc) return null;
  return utc;
}

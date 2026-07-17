// C3.2 统一历史行语义:user=[名字] / assistant=[我] / tool=[内部记录]。
// tool 永不回退成 [用户]——内部记录冒充用户会污染指代理解与压缩摘要。
// brain 重放、triage recent、reply context、compactor earlyText、群窗口(带 HH:MM,自定 fallback)
// 五处共用,禁止各写各的 who 标注。
export function whoLabel(m, { fallback = "用户" } = {}) {
  return m.role === "assistant" ? "我"
    : m.role === "tool" ? "内部记录"
      : m.sender_name ?? m.sender_open_id ?? fallback;
}

export function formatHistoryLine(m) {
  return `[${whoLabel(m)}]: ${m.content}`;
}

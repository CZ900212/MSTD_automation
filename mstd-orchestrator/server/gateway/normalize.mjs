// C2 入站 @ 单趟规范化：结构化 @_user_N（mentions metadata）与纯文本 bot 名
// 编进同一个 alternation，在同一次 replace 中完成检测与替换——mentionsBot 与文本
// 替换永远同源，杜绝"检测说被点名、文本里却没换"或反之的漂移。
// 铁律：只改 mention token 本身；不 trim、不折叠空格/tab/换行。
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// 主名 + aliases：去空、去重、按最长优先（防 @小达 抢在 @小达助手 之前把长名截断）
export function buildBotNames(env = process.env) {
  const names = [String(env.MSTD_BOT_NAME ?? ""), ...String(env.MSTD_BOT_ALIASES ?? "").split(",")]
    .map((s) => s.trim())
    .filter(Boolean);
  return [...new Set(names)].sort((a, b) => b.length - a.length);
}

export function normalizeIncoming(content, { botNames = [], botOpenId = null, mentions = [] } = {}) {
  if (typeof content !== "string" || content === "") {
    return { content: typeof content === "string" ? content : "", mentionsBot: false };
  }
  // 纯文本名左边界：@ 前是 ASCII 词字符（邮箱 local part、粘连英文）就不是 mention。
  // 只排 ASCII——中文粘连（"问@小达"）是飞书选人后无空格的真实形态，必须放行。
  // 结构化 key 有 mentions metadata 背书，不加左边界（"hi@_user_1" 也是真 mention）。
  const LEFT = "(?<![A-Za-z0-9_])";
  const tokens = [];
  for (const m of Array.isArray(mentions) ? mentions : []) {
    const key = m?.key;
    if (typeof key !== "string" || !key.startsWith("@")) continue;
    // bot 判定阶梯与 inbox.structuredBot 完全同源（含裸字符串 id 兜底），防检测/替换分脑
    const openId = m?.id?.open_id ?? m?.open_id ?? (typeof m?.id === "string" ? m.id : null);
    const bot = openId != null && openId === botOpenId;
    tokens.push({
      literal: key,
      pattern: `${escapeRe(key)}(?!\\d)`,                    // @_user_1 不吞 @_user_10
      replacement: bot ? "[@我]" : (typeof m?.name === "string" && m.name ? `@${m.name}` : key),
      bot,
    });
  }
  for (const name of botNames) {
    if (typeof name !== "string" || !name) continue;
    tokens.push({
      literal: `@${name}`,
      // 右边界补 _：@小达_人 是别的用户名,不是 @小达（对计划正则的实施偏差,见计划文件备注）
      pattern: `${LEFT}${escapeRe(`@${name}`)}(?![\\p{L}\\p{N}_])`,
      replacement: "[@我]",
      bot: true,
    });
  }
  if (!tokens.length) return { content, mentionsBot: false };
  tokens.sort((a, b) => b.literal.length - a.literal.length); // 最长优先
  const byLiteral = new Map();
  const kept = [];
  for (const t of tokens) {                                   // 同 literal 只保留首个（畸形重复 key 防名字错配）
    if (byLiteral.has(t.literal)) continue;
    byLiteral.set(t.literal, t);
    kept.push(t);
  }
  const re = new RegExp(kept.map((t) => t.pattern).join("|"), "gu");
  let mentionsBot = false;
  const out = content.replace(re, (matched) => {
    const t = byLiteral.get(matched);                        // pattern 均为 literal+lookahead，matched 即 literal
    if (!t) return matched;
    if (t.bot) mentionsBot = true;
    return t.replacement;
  });
  return { content: out, mentionsBot };
}

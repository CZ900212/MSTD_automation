// 逐字引用守卫（批次 C）：服务端记录 resident 本 epoch 读过的源文本 shingle，
// post-render 时检测输出与已读源的逐字重合。群聊默认禁止逐字引用；私聊/debug 受总量预算。
// 这是辅助信号层（DLP 同级），audience/capability 边界才是主防线——同义改写不在本守卫射程内。
import { createHash } from "node:crypto";

const DEFAULT_WINDOW = 30;   // 归一化后 30 字符 ≈ 一句实义引文，短于此不算"逐字大段"
const DEFAULT_STRIDE = 8;    // 源侧步进 8：任何 ≥ window+stride-1 的连续复制必命中至少一个 shingle
const DEFAULT_MAX_SHINGLES = 50_000; // 每会话上限，FIFO 淘汰（约数 MB 级）
const DEFAULT_P2P_BUDGET = 600;      // 私聊逐字引用总预算（归一化字符）

function normalize(text) {
  return String(text ?? "").normalize("NFKC").replace(/\s+/g, "").toLowerCase();
}

function shingleHash(value) {
  return createHash("sha256").update(value, "utf8").digest("base64").slice(0, 16);
}

export function createVerbatimGuard({
  windowChars = DEFAULT_WINDOW,
  stride = DEFAULT_STRIDE,
  maxShinglesPerSession = DEFAULT_MAX_SHINGLES,
  p2pBudgetChars = DEFAULT_P2P_BUDGET,
} = {}) {
  const sessions = new Map(); // sessionKey -> Set<shingle>（Set 迭代按插入序，可 FIFO 淘汰）

  function record(sessionKey, text) {
    if (!sessionKey) return 0;
    const norm = normalize(text);
    if (norm.length < windowChars) return 0;
    let set = sessions.get(sessionKey);
    if (!set) { set = new Set(); sessions.set(sessionKey, set); }
    let added = 0;
    for (let i = 0; i + windowChars <= norm.length; i += stride) {
      set.add(shingleHash(norm.slice(i, i + windowChars)));
      added++;
    }
    if (set.size > maxShinglesPerSession) {
      const drop = set.size - maxShinglesPerSession;
      let n = 0;
      for (const key of set) { set.delete(key); if (++n >= drop) break; }
    }
    return added;
  }

  // 返回 { ok, code?, verbatimChars }。群聊命中任意窗口即拒；私聊/debug 超预算才拒。
  function check(sessionKey, text, { audience = null } = {}) {
    const set = sessions.get(sessionKey);
    if (!set || set.size === 0) return { ok: true, verbatimChars: 0 };
    const norm = normalize(text);
    if (norm.length < windowChars) return { ok: true, verbatimChars: 0 };
    // 输出侧步进 1，保证与源侧 stride 网格必然对齐一次
    const matched = [];
    for (let i = 0; i + windowChars <= norm.length; i++) {
      if (set.has(shingleHash(norm.slice(i, i + windowChars)))) matched.push(i);
    }
    if (matched.length === 0) return { ok: true, verbatimChars: 0 };
    // 合并重叠窗口估算逐字覆盖字符数
    let verbatimChars = 0;
    let start = matched[0];
    let end = matched[0] + windowChars;
    for (const i of matched.slice(1)) {
      if (i <= end) end = i + windowChars;
      else { verbatimChars += end - start; start = i; end = i + windowChars; }
    }
    verbatimChars += end - start;
    if (audience === "group") {
      return { ok: false, code: "post_render_group_verbatim", verbatimChars };
    }
    if (verbatimChars > p2pBudgetChars) {
      return { ok: false, code: "post_render_verbatim_budget", verbatimChars, budget: p2pBudgetChars };
    }
    return { ok: true, verbatimChars };
  }

  function clear(sessionKey) {
    return sessions.delete(sessionKey);
  }

  function inspect(sessionKey) {
    return { shingles: sessions.get(sessionKey)?.size ?? 0 };
  }

  return { record, check, clear, inspect };
}

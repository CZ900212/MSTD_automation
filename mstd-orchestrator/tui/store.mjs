// 轮询与状态聚合：每次 snapshot() 读一遍只读查询，model_log 用 rowid 游标只取
// 增量并压入环形缓冲。事件的上色/告警分类也在这里，UI 只负责渲染。

// 正则漏掉的 warn kinds；其余 error/fallback/reject/invalid/abandon/rate_limit 由正则覆盖。
const WARN_KINDS = new Set([
  "model_retry", "reply_model_hash_mismatch", "outbound_retry", "responder_send_failed",
]);

function classify(row) {
  const k = row.kind || "";
  if (row.fallback_kind || WARN_KINDS.has(k) || /error|fallback|reject|invalid|abandon|rate_limit/.test(k)) {
    return { color: "yellow", warn: true };
  }
  if (k.startsWith("dispatcher")) return { color: "cyan", warn: false };
  if (k.startsWith("brain")) return { color: "magenta", warn: false };
  if (/reply_sent|responder_sent|quick_reply|business_turn_(admitted|ack|terminal)/.test(k)) {
    return { color: "green", warn: false };
  }
  if (k === "triage") return { color: "blue", warn: false };
  return { color: "gray", warn: false };
}

function label(row) {
  const bits = [row.kind];
  if (row.chain) bits.push(`·${row.chain}`);
  if (row.decision) bits.push(row.decision);
  if (row.from_key) bits.push(`${row.from_key}→${row.to_key || "?"}`);
  if (row.fallback_kind) bits.push(`[${row.fallback_kind}]`);
  if (row.latency_ms != null) bits.push(`${Math.round(row.latency_ms)}ms`);
  const head = bits.filter(Boolean).join(" ");
  const det = (row.detail || "").replace(/\s+/g, " ").trim();
  return det ? `${head} — ${det}` : head;
}

export function createStore({ queries, health, config }) {
  let cursor = 0;
  const feed = [];

  function primeCursor() {
    // 首帧回填最近 ~200 条，而非把历史全部重放。
    cursor = Math.max(0, queries.maxRowid() - 200);
  }

  function pushLocal(text, warn = false) {
    feed.push({ rid: null, ts: Date.now(), text: `» ${text}`, color: warn ? "red" : "greenBright", warn, local: true });
    if (feed.length > config.feedCap) feed.splice(0, feed.length - config.feedCap);
  }

  function snapshot() {
    const h = health.read();
    let err = null;
    let runs = [];
    let reliability = { fallbacks: [], kinds: [], latency: { p50: null, p95: null, n: 0 } };
    let sessions = [];
    try {
      for (const r of queries.tail(cursor)) {
        cursor = r.rid;
        const c = classify(r);
        feed.push({ rid: r.rid, ts: r.ts, text: label(r), color: c.color, warn: c.warn });
      }
      if (feed.length > config.feedCap) feed.splice(0, feed.length - config.feedCap);
      runs = queries.openRuns();
      reliability = queries.reliability(Date.now() - config.windowMs);
      sessions = queries.recentSessions();
    } catch (e) {
      err = e?.message ?? String(e);
    }
    return {
      at: Date.now(),
      err,
      health: h,
      runs,
      running: runs.filter((r) => r.status === "running").length,
      queued: runs.filter((r) => r.status === "queued").length,
      closing: runs.filter((r) => r.status === "closing").length,
      reliability,
      sessions,
      feed,
    };
  }

  return { snapshot, primeCursor, pushLocal };
}

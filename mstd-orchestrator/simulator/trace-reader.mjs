export function createTraceReader(db) {
  const byMessage = db.prepare(
    `SELECT * FROM gateway_turn_trace
     WHERE input_message_ids_json LIKE ?
     ORDER BY flushed_at DESC LIMIT 20`
  );

  function findTraceByMessageId(platformMessageId) {
    if (!platformMessageId) return null;
    const rows = byMessage.all(`%${platformMessageId}%`);
    for (const row of rows) {
      try {
        const ids = JSON.parse(row.input_message_ids_json ?? "[]");
        if (ids.includes(platformMessageId)) return hydrate(row);
      } catch { /* continue */ }
    }
    return null;
  }

  function modelStats(fromTs, toTs) {
    try {
      const rows = db.prepare(
        `SELECT * FROM model_log WHERE ts >= ? AND ts <= ? ORDER BY ts`
      ).all(fromTs, toTs);
      let retries = 0;
      let fallbacks = 0;
      for (const r of rows) {
        const t = r.type ?? r.event_type ?? r.kind ?? "";
        const detail = String(r.detail ?? r.message ?? "");
        if (String(t).includes("retry") || detail.includes("retry")) retries += 1;
        if (String(t).includes("fallback") || String(t).includes("degrad") || detail.includes("fallback")) {
          fallbacks += 1;
        }
      }
      return { retries, fallbacks, events: rows.length };
    } catch {
      return { retries: 0, fallbacks: 0, events: 0 };
    }
  }

  function tokenSum(fromTs, toTs) {
    try {
      // 004_models.sql: column is `tokens`, not total_tokens
      return db.prepare(
        `SELECT COALESCE(SUM(tokens), 0) AS n FROM token_usage WHERE ts >= ? AND ts <= ?`
      ).get(fromTs, toTs)?.n ?? 0;
    } catch {
      return 0;
    }
  }

  return { findTraceByMessageId, modelStats, tokenSum };
}

function hydrate(row) {
  return {
    ...row,
    inputEventIds: safeArr(row.input_event_ids_json),
    inputMessageIds: safeArr(row.input_message_ids_json),
  };
}

function safeArr(s) {
  try {
    const v = JSON.parse(s ?? "[]");
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}

/** Map decision_action / status to scenario route labels (v1). */
export function actualRouteFromTrace(trace) {
  if (!trace) return "unknown";
  const action = trace.decision_action;
  if (action === "quick_reply" || trace.status === "quick_reply") return "quick_reply";
  if (action === "no_reply" || trace.status === "no_reply") return "no_reply";
  if (action === "steer" || trace.status === "steer") return "steer";
  if (action === "escalate" || trace.status === "escalate" || trace.status === "terminal") {
    if (trace.terminal_outcome === "confirm_card") return "confirm_card";
    if (trace.terminal_outcome === "security_refused") return "security_refused";
    return action === "escalate" || trace.business_turn_id ? "escalate" : "unknown";
  }
  if (trace.status === "observe_only") return "observed";
  if (trace.status === "terminal" && trace.business_turn_id) return "escalate";
  return "unknown";
}
